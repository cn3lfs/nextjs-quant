import "./isolation";
import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { researchCandidates, strategyBuildHash } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { researchExecutionAt } from "../../../src/server/research/corporate-actions";
import type { PortfolioInstrument } from "quant-backtest";
import type {
  ValidationDataset,
  FrozenValidationInput,
} from "../../../src/server/research/validation-capture";
import { validationInputSchema } from "../../../src/server/research/validation-model";
import { readCachedResearchCryptoWindow } from "../../../src/server/research/validation-crypto-history";

export { config } from "./isolation";
import { config, outputTask, replayOnly } from "./isolation";
export const task = resolve(config.task);
if (
  !process.env.QUANT_DATA_DIR ||
  !isAbsolute(process.env.QUANT_DATA_DIR) ||
  resolve(process.env.QUANT_DATA_DIR) !== join(outputTask, "data")
)
  throw new Error("R2a4 requires absolute isolated .test-data/r2a4/data");
export const digest = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export async function calculationIdentity(market: "cn-equity" | "crypto") {
  const files = [
    "scripts/lib/research/study.ts",
    "scripts/lib/research/context.ts",
    "scripts/lib/research/isolation.ts",
    "src/server/research/validation-replay.ts",
    "src/server/research/validation-scale.ts",
    "src/server/research/validation-model.ts",
    "src/server/research/validation-capture.ts",
    "src/server/research/corporate-actions.ts",
    "src/lib/backtest/multiple-testing.ts",
    "src/lib/backtest/backtest-overfit.ts",
    "src/lib/backtest/daily-performance.ts",
    "pnpm-lock.yaml",
  ];
  if (market === "crypto")
    files.push(
      "src/server/data-sources/binance/public-data.ts",
      "src/server/data-sources/binance/public-data-store.ts",
    );
  for (const root of [
    "packages/quant-backtest/src",
    "packages/trading-strategies/src",
    "packages/trading-strategy-core/src",
    "packages/quant-performance/src",
  ]) {
    for (const name of await readdir(root, { recursive: true }))
      if (/\.(ts|json)$/.test(name))
        files.push(join(root, name).replaceAll("\\", "/"));
  }
  if (config.batch === "R2a-5") {
    files.push(process.env.QUANT_RESEARCH_CONFIG!);
    if (market === "crypto") files.push("src/server/research/crypto-sizing.ts");
    for (const name of await readdir(task))
      if (name.endsWith("-pointer.json")) files.push(join(task, name));
  }
  const hash = createHash("sha256");
  for (const path of [...new Set(files)].sort())
    hash
      .update(path)
      .update((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
  return hash.digest("hex");
}
export async function json<T>(path: string): Promise<T> {
  if (replayOnly && path === ".codex-runs/delivery.json")
    path = ".codex-runs/delivery.R2a4.json";
  return JSON.parse(await readFile(path, "utf8")) as T;
}
export async function delivery(patch: Record<string, unknown>) {
  if (replayOnly) return;
  const lock = join(task, "delivery.lock");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 250 && !handle; attempt++) {
    try {
      handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  if (!handle)
    throw new Error(
      "Delivery lock busy; checkpoint retained; inspect owner before recovery",
    );
  try {
    const path = resolve(".codex-runs/delivery.json");
    const current = await json<Record<string, unknown>>(path);
    if (current.batch !== config.batch)
      throw new Error("Delivery ownership changed");
    const pending = `${path}.pending.${process.pid}`;
    await writeFile(
      pending,
      JSON.stringify(
        { ...current, ...patch, updatedAt: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    await rename(pending, path);
  } finally {
    await handle.close();
    await unlink(lock);
  }
}

const predecessor = resolve(".test-data/r2a3/artifacts");
const originalIndex = await json<{
  build: string;
  files: Record<string, string>;
}>(join(predecessor, "index.json"));
let lastPacked:
  { name: string; rows: { name: string; bytes: string }[] } | undefined;
/** Old envelopes remain evidence for their recorded build. Reading an input is
 * not permission to publish its old result as a current-engine replay. */
export async function prior<T>(name: string): Promise<T> {
  const filename = `${name}.json.gz`;
  let bytes: Buffer;
  if (originalIndex.files[filename])
    bytes = await readFile(join(predecessor, filename));
  else {
    const packs = await json<Record<string, { pack: string; sha256: string }>>(
      join(predecessor, "repacked.json"),
    );
    const pointer = packs[filename];
    if (!pointer) throw new Error(`Missing predecessor ${name}`);
    if (lastPacked?.name !== pointer.pack)
      lastPacked = {
        name: pointer.pack,
        rows: await prior<{ name: string; bytes: string }[]>(pointer.pack),
      };
    const rows = lastPacked.rows;
    const row = rows.find((r) => r.name === filename);
    if (!row) throw new Error("Repacked input missing");
    bytes = Buffer.from(row.bytes, "base64");
    if (digest(bytes) !== pointer.sha256)
      throw new Error("Repacked original hash mismatch");
  }
  if (
    originalIndex.files[filename] &&
    digest(bytes) !== originalIndex.files[filename]
  )
    throw new Error(`Predecessor hash mismatch ${name}`);
  const envelope = JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 256 * 1024 ** 2 }).toString(),
  ) as { build: string; value: T };
  if (envelope.build !== originalIndex.build)
    throw new Error("Predecessor envelope identity mismatch");
  return envelope.value;
}
export async function artifact(name: string, value: unknown) {
  const root = join(outputTask, "artifacts");
  await mkdir(root, { recursive: true });
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 256 * 1024 ** 2)
    throw new Error("Artifact exceeds 256MiB");
  const bytes = gzipSync(body);
  const path = join(root, `${name}.json.gz`);
  const files = await readdir(root);
  let total = bytes.length;
  for (const f of files)
    if (join(root, f) !== path) total += (await stat(join(root, f))).size;
  const oldFiles = await readdir(predecessor);
  const extraRoots = [
    ...new Set([
      resolve(config.predecessor, "artifacts"),
      resolve(".test-data/r2a5/replay-r2a4/artifacts"),
    ]),
  ].filter((p) => p !== root && p !== predecessor);
  let extraFiles = 0,
    extraBytes = 0;
  for (const directory of extraRoots) {
    try {
      for (const name of await readdir(directory)) {
        extraFiles++;
        extraBytes += (await stat(join(directory, name))).size;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (
    files.length +
      (files.includes(`${name}.json.gz`) ? 0 : 1) +
      oldFiles.length +
      extraFiles >
    100
  )
    throw new Error("Combined artifact file budget exceeded");
  let oldTotal = 0;
  for (const f of oldFiles) oldTotal += (await stat(join(predecessor, f))).size;
  if (total + oldTotal + extraBytes > 4 * 1024 ** 3)
    throw new Error("Combined artifact byte budget exceeded");
  await writeFile(path + ".pending", bytes);
  await rename(path + ".pending", path);
  return { path, sha256: digest(bytes), bytes: bytes.length };
}
export async function readArtifact<T>(pointer: {
  path: string;
  sha256: string;
}): Promise<T> {
  const path = resolve(pointer.path);
  if (
    ![task, resolve(config.predecessor), outputTask].some(
      (root) =>
        path.startsWith(join(root, "artifacts") + "\\") ||
        path.startsWith(join(root, "artifacts") + "/"),
    )
  )
    throw new Error("Artifact path escapes task");
  const bytes = await storedArtifactBytes(path);
  if (digest(bytes) !== pointer.sha256)
    throw new Error("R2a4 artifact hash mismatch");
  return JSON.parse(
    gunzipSync(bytes, { maxOutputLength: 256 * 1024 ** 2 }).toString(),
  ) as T;
}
let packedArtifact: { path: string; rows: Record<string, string> } | undefined;
/** Preserve original gzip bytes and SHA when retired outputs are consolidated. */
async function storedArtifactBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const { dirname, basename } = await import("node:path");
    const mapping = await json<
      Record<string, { pack: string; sha256: string }>
    >(join(dirname(path), "repacked.json"));
    const entry = mapping[basename(path)];
    if (!entry) throw error;
    const pack = join(dirname(path), entry.pack);
    if (packedArtifact?.path !== pack)
      packedArtifact = {
        path: pack,
        rows: JSON.parse(
          gunzipSync(await readFile(pack), {
            maxOutputLength: 256 * 1024 ** 2,
          }).toString(),
        ) as Record<string, string>,
      };
    const bytes = Buffer.from(packedArtifact.rows[basename(path)]!, "base64");
    if (digest(bytes) !== entry.sha256)
      throw new Error("Repacked artifact SHA mismatch");
    return bytes;
  }
}
export type CompactInstrument = {
  symbol: string;
  columns: (string | number)[][];
  rps: (number | null)[];
  sourceHash: string;
  adjustmentReference: string | null;
  actions: PortfolioInstrument["actions"];
  lowFacts?: [string, number | null, number | null][];
  lowObservations?: FrozenValidationInput["lowZones"][number]["observations"];
};
export type EquityManifest = {
  eligible: string[];
  shards: string[];
  benchmark: Bar[];
  audit: { symbol: string; accepted: boolean; reason: string }[];
};
export function barsOf(row: CompactInstrument, signal = false): Bar[] {
  const o = signal ? 7 : 1;
  return row.columns.map((r) => ({
    date: r[0] as string,
    open: r[o] as number,
    high: r[o + 1] as number,
    low: r[o + 2] as number,
    close: r[o + 3] as number,
    volume: r[o + 4] as number,
    amount: r[o + 5] as number,
  }));
}
export function executionOf(
  symbol: string,
  bars: readonly Bar[],
  actions: PortfolioInstrument["actions"] = [],
): PortfolioInstrument["execution"] {
  return (bar, previous) => researchExecutionAt(symbol, bar, previous, actions);
}

export function frozen(dataset: ValidationDataset): FrozenValidationInput {
  return {
    version: "research-validation-input-1",
    input: validationInputSchema.parse({
      market: dataset.instruments[0]!.market,
      start: dataset.dates[0],
      end: dataset.dates.at(-1),
    }),
    root: "E:\\new_tdx64",
    strategyBuildHash,
    validationBuildHash: "R2a4-current-recomputation",
    evidence: {
      universeComplete: false,
      executionVerified: false,
      firstVintageFinancials: false,
    },
    universe: null,
    datasets: [dataset],
    native: [],
    financials: [],
    lowZones: [],
    rpsAudit: [],
    excluded: [],
    gaps: [],
    selection: "R2a4 dispatch fixed scope; prior data are immutable inputs",
    candidateMenu: researchCandidates(
      dataset.instruments.map((i) => i.symbol),
      dataset.instruments[0]!.market,
    ),
  };
}
export async function equity(
  subset?: readonly string[],
  includeRps = false,
  includeLow = false,
) {
  const manifest =
    config.batch === "R2a-5"
      ? await readArtifact<EquityManifest>(
          await json(join(task, "equity-pointer.json")),
        )
      : await prior<EquityManifest>("equity-input");
  const rps = JSON.parse(await prior<string>("rps-root")) as {
    dates: string[];
    universe: FrozenValidationInput["universe"];
  };
  const selected = subset && new Set(subset);
  const instruments: PortfolioInstrument[] = [];
  const sources: ValidationDataset["sources"] = [];
  const lowZones: FrozenValidationInput["lowZones"] = [];
  for (const shard of manifest.shards)
    for (const row of config.batch === "R2a-5"
      ? await readArtifact<CompactInstrument[]>(
          await json(join(task, `${shard}-pointer.json`)),
        )
      : await prior<CompactInstrument[]>(shard)) {
      if (selected && !selected.has(row.symbol)) continue;
      const bars = barsOf(row),
        signalBars = barsOf(row, true);
      const external: NonNullable<PortfolioInstrument["external"]> = {};
      if (includeRps)
        external.rps = rps.dates.map((date, i) => ({
          date,
          periods: [20, 50, 120],
          values: [0, 1, 2].map((p) =>
            row.rps[i * 9 + p * 3] === null
              ? null
              : {
                  return: row.rps[i * 9 + p * 3]!,
                  rank: row.rps[i * 9 + p * 3 + 1]!,
                  rps: row.rps[i * 9 + p * 3 + 2]!,
                },
          ),
        }));
      if (includeLow) {
        external.lowZone =
          row.lowFacts?.map(([date, pe, pb]) => ({
            date,
            availableAt: date,
            pe,
            pb,
            temperature: null,
            confidence: "approximate" as const,
            source: "Frozen PIT-filtered TDX revisions; temperature missing",
          })) ?? [];
        if (row.lowObservations)
          lowZones.push({
            symbol: row.symbol,
            observations: row.lowObservations,
          });
      }
      instruments.push({
        symbol: row.symbol,
        market: "cn-equity",
        bars,
        signalBars,
        execution: executionOf(row.symbol, bars, row.actions),
        external,
        actions: row.actions,
      });
      sources.push({
        symbol: row.symbol,
        hash: row.sourceHash,
        adjustmentReference: row.adjustmentReference,
      });
    }
  const dataset: ValidationDataset = {
    period: "day",
    instruments,
    sources,
    benchmark: manifest.benchmark,
    dates: rps.dates,
    benchmarkName: "Frozen CSI300 raw index; no dividends",
  };
  const base = frozen(dataset);
  base.lowZones = lowZones;
  base.universe = rps.universe;
  return { dataset, base, manifest };
}
export async function crypto(
  period: ValidationDataset["period"],
  pairs?: readonly string[],
  from?: string,
) {
  const input = await prior<{
    coverage: {
      rows: {
        pair: string;
        period: string;
        cacheFile: string;
        cacheSha256: string;
        hash: string;
        bars: number;
      }[];
    };
  }>("crypto-input");
  process.env.QUANT_RESEARCH_BAR_STORE_DIR = resolve(
    ".test-data/r2a2/data/bar-store",
  );
  const instruments: PortfolioInstrument[] = [],
    sources: ValidationDataset["sources"] = [];
  for (const row of input.coverage.rows.filter(
    (r) => r.period === period && (!pairs || pairs.includes(r.pair)),
  )) {
    if (digest(await readFile(row.cacheFile)) !== row.cacheSha256)
      throw new Error("Prior crypto source drift");
    const view = await readCachedResearchCryptoWindow({
      instrument: { market: "crypto", symbol: `cx${row.pair}` },
      period,
      adjustment: "none",
      cryptoSource: "binance",
      from: "1970-01-01",
      to: "2026-11-13",
      limit: 2000000,
    });
    if (
      !view ||
      view.snapshot.hash !== row.hash ||
      view.snapshot.bars.length !== row.bars
    )
      throw new Error("Prior crypto projection drift");
    const first = from
      ? Math.max(
          0,
          view.snapshot.bars.findIndex((b) => b.date.slice(0, 10) >= from) -
            140,
        )
      : 0;
    const bars = view.snapshot.bars.slice(first);
    instruments.push({
      symbol: `cx${row.pair}`,
      market: "crypto",
      bars,
      signalBars: bars,
      execution: {
        evidence: "Frozen grid scenario, historical venue filters unknown",
        minimum: 0.000001,
        step: 0.000001,
        maximum: 1e9,
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    });
    sources.push({
      symbol: `cx${row.pair}`,
      hash: row.hash,
      adjustmentReference: null,
    });
  }
  const benchmark = instruments.find((i) => i.symbol === "cxBTCUSDT")!.bars;
  const dataset: ValidationDataset = {
    period,
    instruments,
    sources,
    benchmark: [...benchmark],
    dates: [
      ...new Set(
        benchmark
          .map((b) => b.date.slice(0, 10))
          .filter((d) => d >= "2020-01-02"),
      ),
    ],
    benchmarkName: "Prior BTC hold, uncharged benchmark",
  };
  return { dataset, base: frozen(dataset) };
}
