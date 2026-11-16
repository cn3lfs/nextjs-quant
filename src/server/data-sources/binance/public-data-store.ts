import {
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir,
  unlink,
  stat,
} from "node:fs/promises";
import { join, resolve, isAbsolute, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { dataDirectory } from "../../db";
import { outboundFetch } from "../../infra/outbound";
import {
  archiveIntervals,
  archiveSymbolSchema,
  archiveIntervalSchema,
  archiveStep,
  checkedArchive,
  parseArchiveCsv,
  sha256,
  rowIdentity,
  type ArchiveInterval,
  type ArchiveRow,
} from "./public-data";

export type ArchiveFile = {
  path: string;
  sha256: string;
  rows: number;
  start: string | null;
  end: string | null;
  verifiedAt: string;
  bytes: number;
  quarantined: { line: number; openTime: number; reason: string }[];
};
export type ArchiveManifest = {
  version: 1;
  symbol: string;
  interval: ArchiveInterval;
  files: ArchiveFile[];
  rows: number;
  start: string | null;
  end: string | null;
  gaps: { from: number; to: number; missingBars: number }[];
  bytes: number;
  updatedAt: string;
  status: "ready" | "incomplete";
  missing: string[];
};
const archiveManifestSchema: z.ZodType<ArchiveManifest> = z.object({
  version: z.literal(1),
  symbol: archiveSymbolSchema,
  interval: archiveIntervalSchema,
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        rows: z.number().int().nonnegative(),
        start: z.string().nullable(),
        end: z.string().nullable(),
        verifiedAt: z.string(),
        bytes: z.number().int().nonnegative(),
        quarantined: z.array(
          z.object({
            line: z.number().int().positive(),
            openTime: z.number().int().nonnegative(),
            reason: z.string(),
          }),
        ),
      }),
    )
    .max(10000),
  rows: z.number().int().nonnegative(),
  start: z.string().nullable(),
  end: z.string().nullable(),
  gaps: z.array(
    z.object({
      from: z.number().int().nonnegative(),
      to: z.number().int().nonnegative(),
      missingBars: z.number().int().positive(),
    }),
  ),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
  status: z.enum(["ready", "incomplete"]),
  missing: z.array(z.string()),
});
type Options = {
  root?: string;
  now?: number;
  signal?: AbortSignal;
  fetcher?: (url: string, signal?: AbortSignal) => Promise<Response>;
  progress?: (done: number, total: number, phase: string) => void;
  minimumRequestMs?: number;
  fromMonth?: string;
  intervals?: readonly ArchiveInterval[];
  symbols?: readonly ("BTCUSDT" | "ETHUSDT")[];
};
export function publicDataRoot(configured = "") {
  if (configured && !isAbsolute(configured))
    throw new Error("Binance archive root must be absolute");
  return configured
    ? resolve(configured)
    : join(dataDirectory(), "market-data", "binance-public-data");
}
const periodPath = (
  root: string,
  symbol: string,
  interval: ArchiveInterval,
  kind: "monthly" | "daily",
) => join(root, "data", "spot", kind, "klines", symbol, interval);
async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function atomic(path: string, bytes: Uint8Array | string) {
  await mkdir(resolve(path, ".."), { recursive: true });
  const temporary = path + `.pending-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
async function compareLive(
  path: string,
  rows: readonly ArchiveRow[],
  interval: ArchiveInterval,
) {
  const dailyPath = path.replace(
    join("monthly", "klines"),
    join("daily", "klines"),
  );
  let candidates = [path.replace(/\.zip$/, ".live.csv")];
  if (dailyPath !== path) {
    const dir = resolve(dailyPath, "..");
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    candidates = names
      .filter(
        (n) =>
          n.startsWith(basename(path).slice(0, -4) + "-") &&
          n.endsWith(".live.csv"),
      )
      .map((n) => join(dir, n));
  }
  const liveFiles = [];
  const official = new Map(rows.map((r) => [r.openTime, rowIdentity(r)]));
  for (const live of candidates) {
    if (!(await exists(live))) continue;
    for (const row of parseArchiveCsv(await readFile(live, "utf8"), interval)
      .rows)
      if (official.get(row.openTime) !== rowIdentity(row))
        throw new Error(
          "Official archive disagrees with live CSV; preserve both for review",
        );
    liveFiles.push(live);
  }
  return liveFiles;
}
async function readZip(path: string, interval: ArchiveInterval, now: number) {
  if (
    (await stat(path)).size > 48 * 1024 ** 2 ||
    (await stat(path + ".CHECKSUM")).size > 1024
  )
    throw new Error("Official archive source size exceeds limit");
  const [bytes, checksum] = await Promise.all([
    readFile(path),
    readFile(path + ".CHECKSUM", "utf8"),
  ]);
  return {
    bytes,
    checksum,
    ...checkedArchive(bytes, checksum, basename(path), interval, now),
  };
}
const monthAfter = (month: string) => {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 7);
};
const dayAfter = (day: string) =>
  new Date(Date.parse(day) + 86400000).toISOString().slice(0, 10);
export async function readPublicData(
  symbol: string,
  interval: ArchiveInterval,
  options: Pick<Options, "root" | "now"> & { includeRows?: boolean } = {},
) {
  archiveSymbolSchema.parse(symbol);
  archiveIntervalSchema.parse(interval);
  const root = publicDataRoot(options.root),
    now = options.now ?? Date.now();
  const paths: string[] = [];
  for (const kind of ["monthly", "daily"] as const) {
    const dir = periodPath(root, symbol, interval, kind);
    try {
      for (const f of (await readdir(dir)).sort())
        if (f.endsWith(".zip") || f.endsWith(".live.csv"))
          paths.push(join(dir, f));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const monthly = new Set(
    paths
      .filter((p) => p.endsWith(".zip") && p.includes("monthly"))
      .map((p) => basename(p).slice(-11, -4)),
  );
  const rows: ArchiveRow[] = [],
    files: ArchiveFile[] = [];
  const gaps: ArchiveManifest["gaps"] = [];
  let previousOpen: number | undefined,
    count = 0,
    start: string | null = null,
    end: string | null = null;
  for (const path of paths.sort((a, b) =>
    basename(a).localeCompare(basename(b)),
  )) {
    const name = basename(path);
    if (
      path.includes("daily") &&
      monthly.has(
        name.slice(
          symbol.length + interval.length + 2,
          symbol.length + interval.length + 9,
        ),
      )
    )
      continue;
    const live = path.endsWith(".live.csv");
    if (live && (await exists(path.replace(/\.live.csv$/, ".zip")))) {
      await compareLive(
        path.replace(/\.live.csv$/, ".zip"),
        (await readZip(path.replace(/\.live.csv$/, ".zip"), interval, now))
          .rows,
        interval,
      );
      continue;
    }
    const decoded = live
      ? {
          bytes: await readFile(path),
          ...parseArchiveCsv(await readFile(path, "utf8"), interval, now),
        }
      : await readZip(path, interval, now);
    if (!live) await compareLive(path, decoded.rows, interval);
    files.push({
      path,
      sha256: sha256(decoded.bytes),
      rows: decoded.rows.length,
      start: decoded.rows[0]?.bar.date ?? null,
      end: decoded.rows.at(-1)?.bar.date ?? null,
      verifiedAt: new Date().toISOString(),
      bytes:
        decoded.bytes.length +
        (live
          ? 0
          : Buffer.byteLength((decoded as { checksum: string }).checksum)),
      quarantined: decoded.quarantined,
    });
    for (const row of decoded.rows) {
      if (previousOpen !== undefined) {
        if (row.openTime <= previousOpen)
          throw new Error("Overlapping Binance source files");
        const missing =
          (row.openTime - previousOpen) / archiveStep[interval] - 1;
        if (missing > 0)
          gaps.push({
            from: previousOpen + archiveStep[interval],
            to: row.openTime - archiveStep[interval],
            missingBars: missing,
          });
      }
      previousOpen = row.openTime;
      count++;
      start ??= row.bar.date;
      end = row.bar.date;
      if (options.includeRows !== false) rows.push(row);
    }
  }
  return { rows, files, gaps, count, start, end };
}
export async function publicDataFiles(
  root: string,
  symbol: string,
  interval: ArchiveInterval,
  from: number,
  to: number,
) {
  archiveSymbolSchema.parse(symbol);
  archiveIntervalSchema.parse(interval);
  const paths: string[] = [];
  for (const kind of ["monthly", "daily"] as const) {
    const dir = periodPath(root, symbol, interval, kind);
    try {
      for (const name of await readdir(dir)) {
        const date = name
          .slice(`${symbol}-${interval}-`.length)
          .replace(/\.(zip|live.csv)$/, "");
        if (!/^\d{4}-\d{2}(-\d{2})?$/.test(date)) continue;
        const start = Date.parse(date.length === 7 ? date + "-01" : date),
          end = Date.parse(
            date.length === 7 ? monthAfter(date) + "-01" : dayAfter(date),
          );
        if (start <= to && end > from) paths.push(join(dir, name));
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  const months = new Set(
    paths
      .filter((p) => p.includes("monthly") && p.endsWith(".zip"))
      .map((p) =>
        basename(p).slice(
          `${symbol}-${interval}-`.length,
          `${symbol}-${interval}-`.length + 7,
        ),
      ),
  );
  const selected = paths.filter(
    (p) =>
      !(
        p.includes("daily") &&
        months.has(
          basename(p).slice(
            `${symbol}-${interval}-`.length,
            `${symbol}-${interval}-`.length + 7,
          ),
        )
      ) &&
      !(
        p.endsWith(".live.csv") &&
        paths.includes(p.replace(/\.live.csv$/, ".zip"))
      ),
  );
  const superseded = paths.filter(
    (p) => p.endsWith(".live.csv") && !selected.includes(p),
  );
  for (const live of superseded) {
    const daily = live.replace(/\.live.csv$/, ".zip");
    const official = paths.includes(daily)
      ? daily
      : paths.find(
          (p) =>
            p.includes(join("monthly", "klines")) &&
            basename(live).startsWith(basename(p).slice(0, -4) + "-"),
        );
    if (official)
      await compareLive(
        official,
        (await readZip(official, interval, Date.now())).rows,
        interval,
      );
  }
  return selected.sort();
}
/** Explicit user operation only. Official ZIP + CHECKSUM are durable inputs;
 * partial downloads never replace an accepted pair. Restart rechecks each pair. */
export async function backfillPublicData(options: Options = {}) {
  const root = publicDataRoot(options.root),
    now = options.now ?? Date.now(),
    today = new Date(now).toISOString().slice(0, 10),
    month = today.slice(0, 7);
  const plans: {
    symbol: string;
    interval: ArchiveInterval;
    kind: "monthly" | "daily";
    date: string;
  }[] = [];
  for (const symbol of options.symbols ?? ["BTCUSDT", "ETHUSDT"])
    for (const interval of options.intervals ?? archiveIntervals) {
      archiveSymbolSchema.parse(symbol);
      archiveIntervalSchema.parse(interval);
      for (let m = options.fromMonth ?? "2017-08"; m < month; m = monthAfter(m))
        plans.push({ symbol, interval, kind: "monthly", date: m });
      for (let d = month + "-01"; d < today; d = dayAfter(d))
        plans.push({ symbol, interval, kind: "daily", date: d });
    }
  let last = 0,
    done = 0;
  const missing = new Map<string, string[]>();
  const fetcher =
    options.fetcher ??
    (async (url: string, signal?: AbortSignal) =>
      (await outboundFetch(url, { signal })).response);
  const get = async (url: string) => {
    options.signal?.throwIfAborted();
    const wait = (options.minimumRequestMs ?? 75) - (Date.now() - last);
    if (wait > 0) await delay(wait, undefined, { signal: options.signal });
    last = Date.now();
    const r = await fetcher(url, options.signal);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Public Binance download HTTP ${r.status}`);
    const length = Number(r.headers.get("content-length"));
    if (length > 48 * 1024 ** 2) throw new Error("Archive download too large");
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > 48 * 1024 ** 2)
      throw new Error("Archive download too large");
    return bytes;
  };
  const ensure = async (p: (typeof plans)[number]) => {
    const filename = `${p.symbol}-${p.interval}-${p.date}.zip`,
      path = join(periodPath(root, p.symbol, p.interval, p.kind), filename);
    try {
      const accepted = await readZip(path, p.interval, now);
      const live = await compareLive(path, accepted.rows, p.interval);
      for (const file of live) await unlink(file);
      return true;
    } catch (e) {
      if (
        (e as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(e instanceof Error && e.message.includes("CHECKSUM"))
      )
        throw e;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = `https://data.binance.vision/data/spot/${p.kind}/klines/${p.symbol}/${p.interval}/${filename}`;
      const checksumBytes = await get(url + ".CHECKSUM");
      if (!checksumBytes) return false;
      const bytes = await get(url);
      if (!bytes) return false;
      const checksum = Buffer.from(checksumBytes).toString();
      try {
        checkedArchive(bytes, checksum, filename, p.interval, now);
      } catch (e) {
        if (
          attempt === 0 &&
          e instanceof Error &&
          e.message.includes("CHECKSUM")
        )
          continue;
        throw e;
      }
      const live = await compareLive(
        path,
        checkedArchive(bytes, checksum, filename, p.interval, now).rows,
        p.interval,
      );
      await atomic(path + ".CHECKSUM", checksum);
      await atomic(path, bytes);
      for (const file of live) await unlink(file);
      return true;
    }
    return false;
  };
  for (const p of plans) {
    let accepted = await ensure(p);
    // Monthly files publish on the first Monday, so use official daily files
    // until the monthly becomes available. No REST history pagination.
    if (!accepted && p.kind === "monthly" && monthAfter(p.date) === month) {
      accepted = true;
      for (
        let day = p.date + "-01";
        day.slice(0, 7) === p.date;
        day = dayAfter(day)
      )
        if (!(await ensure({ ...p, kind: "daily", date: day })))
          accepted = false;
    }
    if (!accepted) {
      const key = `${p.symbol}/${p.interval}`;
      const list = missing.get(key) ?? [];
      list.push(`${p.kind}/${p.date}`);
      missing.set(key, list);
    }
    options.progress?.(
      ++done,
      plans.length,
      `${p.symbol} ${p.interval} ${p.date}`,
    );
  }
  const summaries: ArchiveManifest[] = [];
  for (const symbol of options.symbols ?? ["BTCUSDT", "ETHUSDT"])
    for (const interval of options.intervals ?? archiveIntervals) {
      const absent = missing.get(`${symbol}/${interval}`) ?? [];
      const recent = absent
        .filter((d) => d.startsWith("daily/"))
        .map((d) => d.slice(6))
        .filter((d) => Date.parse(d) >= Date.parse(today) - 2 * 86400000);
      // A not-yet-published yesterday archive also needs a labelled REST tail.
      for (const liveDay of [...new Set([...recent, today])]) {
        const start = Date.parse(liveDay),
          end = Math.min(now, start + 86400000),
          step = archiveStep[interval];
        let cursor = start;
        const liveRows: string[] = [];
        while (cursor + step <= end) {
          const data = await get(
            `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${end - 1}&limit=1000`,
          );
          if (!data) break;
          const raw: unknown = JSON.parse(Buffer.from(data).toString());
          if (
            !Array.isArray(raw) ||
            raw.some((r) => !Array.isArray(r) || r.length !== 12)
          )
            throw new Error("Invalid live kline response");
          if (!raw.length) break;
          for (const r of raw as (string | number)[][])
            if (Number(r[0]) >= start && Number(r[6]) < end)
              liveRows.push(r.join(","));
          const next = Number((raw.at(-1) as unknown[])[0]) + step;
          if (next <= cursor)
            throw new Error("Live pagination did not advance");
          cursor = next;
        }
        if (liveRows.length) {
          const path = join(
            periodPath(root, symbol, interval, "daily"),
            `${symbol}-${interval}-${liveDay}.live.csv`,
          );
          const csv = liveRows.join("\n") + "\n";
          parseArchiveCsv(csv, interval, now);
          await atomic(path, csv);
        }
      }
      const view = await readPublicData(symbol, interval, {
        root,
        now,
        includeRows: false,
      });
      const manifest: ArchiveManifest = {
        version: 1,
        symbol,
        interval,
        files: view.files,
        rows: view.count,
        start: view.start,
        end: view.end,
        gaps: view.gaps,
        bytes: view.files.reduce((n, f) => n + f.bytes, 0),
        updatedAt: new Date().toISOString(),
        status: absent.length ? "incomplete" : "ready",
        missing: absent,
      };
      await atomic(
        join(periodPath(root, symbol, interval, "monthly"), "manifest.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
      summaries.push(manifest);
    }
  return { root, series: summaries };
}
/** A fresh REST tail does not prove continuity with the older official files. */
function manifestCoverage(manifest: ArchiveManifest) {
  const step = archiveStep[manifest.interval];
  const bounds = (start: string | null, end: string | null) => ({
    from: start
      ? Date.parse(start) - (manifest.interval === "1d" ? 0 : step)
      : NaN,
    to: end ? Date.parse(end) + (manifest.interval === "1d" ? step : 0) : NaN,
  });
  const ranges = manifest.files
    .filter((f) => f.rows > 0)
    .map((f) => ({ ...bounds(f.start, f.end), rows: f.rows }));
  const valid =
    ranges.length > 0 &&
    ranges.every(
      (r) =>
        Number.isFinite(r.from) &&
        Number.isFinite(r.to) &&
        r.to > r.from &&
        r.from % step === 0 &&
        r.to % step === 0 &&
        r.rows === (r.to - r.from) / step,
    );
  const ordered = ranges
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to))
    .sort((a, b) => a.from - b.from);
  const gaps = manifest.gaps.map((g) => ({ from: g.from, to: g.to + step }));
  let through = ordered[0]?.to ?? NaN;
  for (const range of ordered.slice(1)) {
    if (range.from > through) gaps.push({ from: through, to: range.from });
    through = Math.max(through, range.to);
  }
  let quarantinedRows = 0;
  for (const file of manifest.files)
    for (const row of file.quarantined) {
      quarantinedRows++;
      gaps.push({ from: row.openTime, to: row.openTime + step });
    }
  const merged: { from: number; to: number }[] = [];
  for (const gap of gaps.sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && gap.from <= last.to) last.to = Math.max(last.to, gap.to);
    else merged.push({ ...gap });
  }
  const declared = bounds(manifest.start, manifest.end);
  return {
    known:
      valid &&
      (ordered[0]?.from ?? Infinity) <= declared.from &&
      through >= declared.to,
    gaps: merged.length,
    quarantinedRows,
  };
}

/** Read only the small manifest indexes on startup; never trigger a backfill. */
export async function publicDataStatus(
  root = publicDataRoot(),
  now = Date.now(),
) {
  const series: {
    symbol: string;
    interval: ArchiveInterval;
    manifest:
      | (Omit<ArchiveManifest, "files"> & {
          fileCount: number;
          coverage: ReturnType<typeof manifestCoverage>;
        })
      | null;
  }[] = [];
  for (const symbol of ["BTCUSDT", "ETHUSDT"])
    for (const interval of archiveIntervals) {
      const file = join(
        periodPath(root, symbol, interval, "monthly"),
        "manifest.json",
      );
      if (await exists(file)) {
        if ((await stat(file)).size > 16 * 1024 ** 2)
          throw new Error("Archive manifest exceeds16MiB");
        const manifest = archiveManifestSchema.parse(
          JSON.parse(await readFile(file, "utf8")),
        );
        if (manifest.symbol !== symbol || manifest.interval !== interval)
          throw new Error("Archive manifest identity mismatch");
        const { files, ...summary } = manifest;
        series.push({
          symbol,
          interval,
          manifest: {
            ...summary,
            fileCount: files.length,
            coverage: manifestCoverage(manifest),
          },
        });
      } else series.push({ symbol, interval, manifest: null });
    }
  return {
    root,
    alertReadiness: series
      .filter((s) => s.interval === "1d" || s.interval === "4h")
      .map((s) => {
        const end = s.manifest?.end ?? null;
        const completedThrough = end
          ? Date.parse(end) + (s.interval === "1d" ? 86400000 : 0)
          : null;
        const requiredThrough =
          Math.floor(now / archiveStep[s.interval]) * archiveStep[s.interval];
        return {
          symbol: s.symbol,
          interval: s.interval,
          end,
          requiredThrough: new Date(requiredThrough).toISOString(),
          ready:
            completedThrough !== null &&
            completedThrough >= requiredThrough &&
            s.manifest!.coverage.known &&
            s.manifest!.coverage.gaps === 0 &&
            s.manifest!.coverage.quarantinedRows === 0,
          gaps: s.manifest?.coverage.gaps ?? null,
          coverageKnown: s.manifest?.coverage.known ?? false,
          quarantinedRows: s.manifest?.coverage.quarantinedRows ?? null,
        };
      }),
    needsBackfill: series.some(
      (s) =>
        !s.manifest ||
        s.manifest.status !== "ready" ||
        !s.manifest.end ||
        Date.parse(s.manifest.end) + (s.interval === "1d" ? 86400000 : 0) <
          Math.floor(now / archiveStep[s.interval]) * archiveStep[s.interval],
    ),
    series,
  };
}

const liveRefresh = new Map<
  string,
  { boundary: number; pending: Promise<void> }
>();
/** Once a historical archive exists, keep only the recent completed tail up to
 * date. This bounded public REST read never starts a historical backfill. */
export async function refreshPublicDataLive(
  symbol: string,
  interval: ArchiveInterval,
  options: Pick<Options, "root" | "now" | "signal" | "fetcher"> = {},
) {
  archiveSymbolSchema.parse(symbol);
  archiveIntervalSchema.parse(interval);
  const root = publicDataRoot(options.root),
    now = options.now ?? Date.now(),
    step = archiveStep[interval];
  const manifestPath = join(
    periodPath(root, symbol, interval, "monthly"),
    "manifest.json",
  );
  if (!(await exists(manifestPath))) return;
  const key = `${root}/${symbol}/${interval}`,
    boundary = Math.floor(now / step);
  const old = liveRefresh.get(key);
  if (old?.boundary === boundary) return old.pending;
  const pending = (async () => {
    const today = new Date(now).toISOString().slice(0, 10),
      start = Date.parse(today) - 86400000;
    const response = options.fetcher
      ? await options.fetcher(
          `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${now - 1}&limit=1000`,
          options.signal,
        )
      : (
          await outboundFetch(
            `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&endTime=${now - 1}&limit=1000`,
            { signal: options.signal },
          )
        ).response;
    if (!response.ok)
      throw new Error(`Public Binance live HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 2 * 1024 ** 2)
      throw new Error("Live Binance response exceeds2MiB");
    const raw: unknown = JSON.parse(body);
    if (
      !Array.isArray(raw) ||
      raw.some((r) => !Array.isArray(r) || r.length !== 12)
    )
      throw new Error("Invalid live kline response");
    const decoded = parseArchiveCsv(
      raw.map((r) => (r as unknown[]).join(",")).join("\n"),
      interval,
      now,
    );
    const grouped = new Map<string, ArchiveRow[]>();
    for (const r of decoded.rows) {
      if (r.openTime < start)
        throw new Error("Live response outside requested tail");
      const day = new Date(r.openTime).toISOString().slice(0, 10);
      const a = grouped.get(day) ?? [];
      a.push(r);
      grouped.set(day, a);
    }
    const manifest = archiveManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
    for (const [day, rows] of grouped) {
      const path = join(
        periodPath(root, symbol, interval, "daily"),
        `${symbol}-${interval}-${day}.live.csv`,
      );
      if (await exists(path.replace(/\.live.csv$/, ".zip"))) continue;
      const merged = new Map<number, ArchiveRow>();
      if (await exists(path))
        for (const r of parseArchiveCsv(
          await readFile(path, "utf8"),
          interval,
          now,
        ).rows)
          merged.set(r.openTime, r);
      for (const r of rows) {
        const previous = merged.get(r.openTime);
        if (previous && rowIdentity(previous) !== rowIdentity(r))
          throw new Error(
            "Completed REST candle changed; preserve prior source for review",
          );
        merged.set(r.openTime, r);
      }
      const all = [...merged.values()].sort((a, b) => a.openTime - b.openTime);
      const text = all.map((r) => r.columns.join(",")).join("\n") + "\n";
      await atomic(path, text);
      const record: ArchiveFile = {
        path,
        sha256: sha256(text),
        rows: all.length,
        start: all[0]?.bar.date ?? null,
        end: all.at(-1)?.bar.date ?? null,
        verifiedAt: new Date().toISOString(),
        bytes: Buffer.byteLength(text),
        quarantined: decoded.quarantined,
      };
      const previous = manifest.files.find((f) => f.path === path);
      manifest.rows += record.rows - (previous?.rows ?? 0);
      manifest.bytes += record.bytes - (previous?.bytes ?? 0);
      manifest.files = [
        ...manifest.files.filter((f) => f.path !== path),
        record,
      ];
      if (record.end && (!manifest.end || record.end > manifest.end))
        manifest.end = record.end;
    }
    manifest.updatedAt = new Date().toISOString();
    await atomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  })();
  if (liveRefresh.size >= 32)
    liveRefresh.delete(liveRefresh.keys().next().value!);
  liveRefresh.set(key, { boundary, pending });
  try {
    await pending;
  } catch (e) {
    if (liveRefresh.get(key)?.pending === pending) liveRefresh.delete(key);
    throw e;
  }
}
