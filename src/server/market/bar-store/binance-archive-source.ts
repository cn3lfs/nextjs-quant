import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { Snapshot } from "~/lib/domain";
import {
  publicDataFiles,
  publicDataRoot,
} from "../../data-sources/binance/public-data-store";
import {
  archiveStep,
  verifyArchiveChecksum,
  checkedArchive,
  parseArchiveCsv,
  sha256,
  type ArchiveInterval,
  type ArchiveRow,
} from "../../data-sources/binance/public-data";
import { readColumnCache, writeColumnCache } from "./column-cache";

/** Source files survive cache eviction. Every read authenticates selected ZIPs
 * against their CHECKSUM, including on a decoded-column cache hit. */
export async function binanceArchiveSource(input: {
  symbol: string;
  period: ChartPeriod;
  configuredRoot: string;
  from?: string;
  to?: string;
  limit?: number;
  now: number;
}): Promise<Snapshot | null> {
  const pair = input.symbol.slice(2);
  if (
    !["BTCUSDT", "ETHUSDT"].includes(pair) ||
    !["day", "4h", "1h", "60m", "15m", "5m"].includes(input.period)
  )
    return null;
  const interval = (
    input.period === "day" ? "1d" : input.period === "60m" ? "1h" : input.period
  ) as ArchiveInterval;
  const root = publicDataRoot(input.configuredRoot),
    step = archiveStep[interval];
  const to = input.to
    ? Date.parse(input.to) + (input.to.length === 10 ? 86400000 - 1 : 0)
    : input.now;
  const from = input.from
    ? Date.parse(input.from)
    : input.limit
      ? to - (input.limit + 10) * step
      : 0;
  const files = await publicDataFiles(root, pair, interval, from, to);
  if (!files.length) return null;
  const sources = [];
  for (const path of files) {
    if ((await stat(path)).size > 48 * 1024 ** 2)
      throw new Error("Binance durable source exceeds48MiB");
    const bytes = await readFile(path);
    const checksum = path.endsWith(".zip")
      ? await readFile(path + ".CHECKSUM", "utf8")
      : null;
    if (checksum !== null)
      verifyArchiveChecksum(bytes, checksum, basename(path));
    sources.push({ path, bytes, checksum, hash: sha256(bytes) });
  }
  const fingerprint = sha256(
    JSON.stringify({
      version: "binance-public-data-columns-1",
      interval,
      root,
      completedBoundary: files.some((path) => {
        const date = basename(path)
          .slice(`${pair}-${interval}-`.length)
          .replace(/\.(zip|live.csv)$/, "");
        const start = Date.parse(date.length === 7 ? date + "-01" : date);
        const end =
          date.length === 7
            ? Date.UTC(
                new Date(start).getUTCFullYear(),
                new Date(start).getUTCMonth() + 1,
                1,
              )
            : start + 86400000;
        return end > input.now;
      })
        ? Math.floor(input.now / step)
        : null,
      files: sources.map((s) => [s.path, s.hash]),
    }),
  );
  const key = `binance-public-data:${root}:${pair}:${interval}:${sha256(files.join("\n"))}`;
  let cached: ReturnType<typeof readColumnCache> = null;
  try {
    cached = readColumnCache(key);
  } catch {
    /* Derived columns can be rebuilt from authenticated durable inputs. */
  }
  if (cached?.metadata.fingerprint === fingerprint)
    return { ...cached.metadata.source, bars: cached.bars } as Snapshot;
  const rows: ArchiveRow[] = [];
  let issueCount = 0;
  for (const s of sources) {
    const decoded =
      s.checksum === null
        ? parseArchiveCsv(s.bytes.toString(), interval, input.now)
        : checkedArchive(
            s.bytes,
            s.checksum,
            basename(s.path),
            interval,
            input.now,
          );
    rows.push(...decoded.rows);
    issueCount += decoded.quarantined.length;
  }
  rows.sort((a, b) => a.openTime - b.openTime);
  if (rows.some((r, i) => i > 0 && r.openTime <= rows[i - 1]!.openTime))
    throw new Error("Overlapping official Binance archive bars");
  const source: Omit<Snapshot, "bars"> = {
    id: `snapshot-${input.symbol}-${fingerprint}`,
    symbol: input.symbol,
    period: (input.period === "60m"
      ? "1h"
      : input.period) as Snapshot["period"],
    adjustment: "none",
    createdAt: input.now,
    hash: fingerprint,
    source: "binance-public-data",
    sourceVersions: sources.map((s) => s.hash),
    dataRoot: root,
    ...(issueCount
      ? {
          sourceNote: `${issueCount} 条官方时间异常已隔离，原 ZIP 保留；详见 manifest.json`,
        }
      : {}),
  };
  const bars = rows.map((r) => r.bar);
  writeColumnCache(key, bars, fingerprint, source);
  return { ...source, bars };
}
