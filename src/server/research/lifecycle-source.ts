import type { PortfolioRequest, PortfolioInstrument } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  parseGbbqFile,
  adjustmentFactors,
  applyAdjustmentAtAnchor,
} from "tstdx/local";
import type { StrategyBookFacts } from "trading-strategies";
import {
  csi800SignalBars,
  classicFinancialFeatures,
  type Csi800Stock,
  type ClassicWeek,
  type StrategyObjectInput,
  type MarketLowZoneInput,
} from "trading-strategies";
import {
  financialVisibleAt,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { rankRps } from "quant-rps";
import type { FormulaRpsPoint } from "trading-strategies/formula/tdx-formula";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  stat,
  mkdir,
  writeFile,
  readdir,
  appendFile,
} from "node:fs/promises";
import { resolve, isAbsolute, relative, join, dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";
import { publicDataFiles } from "../data-sources/binance/public-data-store";
import { researchExecutionAt } from "./corporate-actions";
import { researchCorporateActions } from "./corporate-actions";
import {
  readIndustryBlocks,
  parseIndustryMembers,
} from "../market/industry-blocks";
import { readBars } from "../market/bar-store/read-bars";
import { columnCacheDirectory } from "../market/bar-store/column-cache";

export const lifecycleConfigHash =
  "b3793b9e455b5e4a563dc0ba526f43ad8854d1672f18613e604492fac68da97f";
export const lifecycleRpsPeriods = [
  18, 20, 22, 45, 50, 55, 108, 120, 132,
] as const;
export type LifecycleSourceKey = "cn-day" | "crypto-day" | "crypto-4h";
export type LifecycleFamilyAxis = {
  dailyAxis: string[];
  axisHash: string;
  sourceKeys: LifecycleSourceKey[];
  firstSignal?: string;
  warmupStart: string | null;
  warmupBars: number;
  targetThrough: string | null;
  valuationThrough: string | null;
  missing: string[];
};
export type LifecycleMarketSource = {
  request: Omit<
    PortfolioRequest,
    "strategies" | "sleeves" | "start" | "end" | "bookFacts"
  >;
  benchmark: readonly Bar[];
  bookFacts: StrategyBookFacts;
  inputHash: string;
  source: string;
  missing: string[];
  actionCoverage?: Readonly<
    Record<
      string,
      { from: string; through: string; source: string; hash: string }
    >
  >;
  rawUniverse?: { symbols: readonly string[]; source: string; hash: string };
  executionUniverse?: {
    symbols: readonly string[];
    source: string;
    hash: string;
  };
  signalBasis?: LifecycleSignalBasis;
};
export type LifecycleSignalOrigin = {
  symbol: string;
  startDate: string;
  through: string;
  anchor: { date: string; factor: number };
  rawSource: {
    format: "bar-tuples-1";
    path: string;
    hash: string;
    decodedContentHash: string;
    upstream?: unknown;
  };
  rawPrefixHash: string;
  eventsPrefixHash: string;
  factorsPrefixHash: string;
  signalPrefixHash: string;
  legacyForwardComparisonHash?: string;
};
export type LifecycleSignalBasis = {
  version: "tdx-first-raw-anchor-1";
  arithmetic: "rawOHLC*(F(t)/F(firstFrozenRawDate))";
  factorAlgorithmHash: string;
  gbbq: {
    path: string;
    hash: string;
    indexPath: string;
    indexHash: string;
    sourcePath: string;
    sourceHash: string;
    capturedAt: string;
    parserHash: string;
    parserKeyHash: string;
    runtimeHash: string;
    runtimeKeyHash: string;
    issues: unknown[];
    recordCount: number;
    bias: string;
  };
  origins: LifecycleSignalOrigin[];
};
export type LifecycleSourceBundle = {
  version: "lifecycle-source-1";
  configHash: string;
  frozenAt: string;
  inputHash: string;
  source: string;
  biasTags: string[];
  markets: Record<LifecycleSourceKey, LifecycleMarketSource>;
  families: Record<string, LifecycleFamilyAxis>;
  manifestPath: string;
  lowZoneSources: {
    indices: LifecycleLowZoneIndex[];
    membership: {
      path: string;
      hash: string;
      symbols: string[];
      basis: "current-labelled";
    } | null;
    financial: {
      path: string;
      hash: string;
      format: string;
      decoded: boolean;
      missing: string[];
    };
  };
  lowZoneInput?: MarketLowZoneInput;
};
export type LifecycleLowZoneIndex = {
  symbol: "sh000300" | "sh000001";
  role: "primary" | "diagnostic";
  bars: readonly Bar[];
  sourcePath: string;
  hash: string;
  sourceHash: string;
  missing: string[];
  archive?: {
    path: string;
    hash: string;
    decodedContentHash: string;
    pointerPath: string;
    pointerHash: string;
  };
};
export type LifecycleSourceOptions = {
  expectedConfigHash?: string;
  classicManifestPath?: string;
  reconstructionPath?: string;
  expectedRawPoolSize?: number;
  executionCapture?: {
    equityPointerPath: string;
    rosterPointerPath: string;
    correctionPath: string;
    expectedEquityHash: string;
    expectedRosterHash: string;
    expectedExecutionCount: number;
    excludedSymbols: readonly string[];
  };
  binanceRoot?: string;
  industryRoot?: string | null;
  expectedIndustryHash?: string;
  tdxRoot?: string | null;
  lowZoneMembershipPath?: string | null;
  expectedLowZoneMembershipHash?: string;
  /** Full original 799 financial decode is a separate budgeted source read. */
  decodeLowZoneFinancials?: boolean;
  gbbqPath?: string;
  expectedGbbqHash?: string;
  terminalStatusPath?: string | null;
  outputRoot?: string;
  now?: number;
};

const dayMs = 86400000;
const sourceCacheBudget = 512 * 1024 ** 2;
const processBudget = 4096 * 1024 ** 2;
class LifecycleSourceBudgetError extends Error {}
const defaultBinanceRoot =
  "D:/github/nextjs-quant/.test-data/r2a4/data/market-data/binance-public-data";
const defaultIndustryRoot = "D:/quant-data/wdz-blocks/2026-11-07/Blocks";
const defaultIndustryHash =
  "73c2a6d4bf5d876e30a1d14ce789285747109334f87a03e7224de0313542825b";
const defaultLowMembership =
  "D:/quant-data/wdz-blocks/2026-11-07/Blocks/市场分类/沪深300.txt";
const defaultLowMembershipHash =
  "f756d51c59b843dff757c839a95968fd58c5755e2199065b14a6304124f4a6d9";
const defaultExecutionCapture = {
  equityPointerPath: ".test-data/r2a5/equity-pointer.json",
  rosterPointerPath: ".test-data/r2a5/csi800-pointer.json",
  correctionPath: ".test-data/lifecycle-20261116/l3/source-correction.json",
  expectedEquityHash:
    "0711ca3b3ece57c5ca53795ab352cbe176889072604ee77397ad225852b71f41",
  expectedRosterHash:
    "bd28be57f28ffdd9cc86c4a43037fb31547a168fb5ec518b99fa5ea93dab5aa7",
  expectedExecutionCount: 799,
  excludedSymbols: ["sz000831"],
};
const bytesHash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const canonicalValue = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalValue)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalValue(item)]),
        )
      : value;
export const lifecycleContentHash = (value: unknown) =>
  bytesHash(JSON.stringify(canonicalValue(value)));
const contentHash = lifecycleContentHash;
const barTuples = (bars: readonly Bar[]) =>
  bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume, b.amount]);
export const lifecycleRawPrefixHash = (bars: readonly Bar[]) =>
  contentHash(barTuples(bars));
export async function readLifecycleSourceManifest(
  path: string,
  expectedInputHash?: string,
) {
  const value = JSON.parse(await readFile(path, "utf8")) as {
    version: string;
    inputHash: string;
    configHash: string;
    identities: {
      classic: {
        files: { path: string; hash: string }[];
        signalBasis?: LifecycleSignalBasis;
      };
      [key: string]: unknown;
    };
  };
  if (
    value.version !== "lifecycle-source-1" ||
    contentHash(value.identities) !== value.inputHash ||
    (expectedInputHash && value.inputHash !== expectedInputHash)
  )
    throw new Error("Frozen lifecycle source manifest identity mismatch");
  return value;
}
export async function readLifecycleSignalOriginBars(
  origin: LifecycleSignalOrigin,
): Promise<Bar[]> {
  const bytes = await readFile(origin.rawSource.path);
  if (bytesHash(bytes) !== origin.rawSource.hash)
    throw new Error("Frozen symbol raw-prefix bytes changed");
  const plain = gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 });
  if (bytesHash(plain) !== origin.rawSource.decodedContentHash)
    throw new Error("Frozen symbol raw-prefix content changed");
  const rows = JSON.parse(plain.toString()) as (string | number)[][];
  const bars = rows.map((r) => ({
    date: String(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    amount: Number(r[6]),
  }));
  orderedBars(bars, origin.symbol);
  if (
    bars[0]?.date !== origin.startDate ||
    bars.at(-1)?.date !== origin.through ||
    lifecycleRawPrefixHash(bars) !== origin.rawPrefixHash
  )
    throw new Error("Frozen symbol raw-prefix proof mismatch");
  return bars;
}
const dayAfter = (date: string, count = 1) =>
  new Date(Date.parse(date) + count * dayMs).toISOString().slice(0, 10);
const naturalDays = (start: string, end: string) =>
  Array.from(
    {
      length: Math.max(
        0,
        Math.round((Date.parse(end) - Date.parse(start)) / dayMs) + 1,
      ),
    },
    (_, i) => dayAfter(start, i),
  );
function memoryBoundary(additional = 0) {
  const rss = process.memoryUsage().rss,
    peak = process.resourceUsage().maxRSS * 1024;
  if (rss + additional > processBudget || peak > processBudget)
    throw new LifecycleSourceBudgetError(
      `Lifecycle source exceeds the single-process 4096MiB budget: rss=${rss}, nativePeak=${peak}, projectedAdditional=${additional}`,
    );
}
type SourceStage = (stage: string) => Promise<void>;
async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
/** Keep large encoded inputs outside the lifetime of the shared parsed bundle. */
async function verifiedSourceJson<T>(
  path: string,
  fileHash: string,
  gzip?: { maxOutputLength: number; contentHash?: string },
): Promise<T> {
  if (!gzip) memoryBoundary((await stat(path)).size * 3);
  const encoded = await readFile(path);
  if (bytesHash(encoded) !== fileHash)
    throw new Error(`Frozen classic source bytes changed during read: ${path}`);
  if (gzip)
    memoryBoundary(
      encoded.readUInt32LE(encoded.length - 4) * 3 + encoded.length,
    );
  const plain = gzip ? gunzipSync(encoded, gzip) : encoded;
  if (gzip?.contentHash && bytesHash(plain) !== gzip.contentHash)
    throw new Error("Frozen classic panel content hash mismatch");
  return JSON.parse(plain.toString()) as T;
}
async function derivedBytes(directory: string) {
  let bytes = 0;
  try {
    for (const file of await readdir(directory, { withFileTypes: true }))
      if (file.isFile()) bytes += (await stat(join(directory, file.name))).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return bytes;
}
async function sourceDiskBoundary(
  output: string,
  rankPath: string,
  rankBytes: number,
  additionalDecoded: number,
) {
  let pendingRank = rankBytes;
  try {
    await stat(rankPath);
    pendingRank = 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    (await derivedBytes(output)) +
      (await derivedBytes(columnCacheDirectory())) +
      pendingRank +
      additionalDecoded >
    sourceCacheBudget
  )
    throw new LifecycleSourceBudgetError(
      "Projected lifecycle source cache exceeds512MiB before reader/cache write",
    );
}
async function normalizedArtifact<T>(
  pointerPath: string,
  expectedHash?: string,
) {
  const pointerBytes = await readFile(pointerPath),
    pointer = JSON.parse(pointerBytes.toString()) as {
      path: string;
      sha256: string;
      bytes?: number;
    };
  if (
    !isAbsolute(pointer.path) ||
    !/^([a-f0-9]{64})$/.test(pointer.sha256) ||
    (expectedHash && pointer.sha256 !== expectedHash)
  )
    throw new Error("Frozen normalized capture pointer identity mismatch");
  const bytes = await readFile(pointer.path);
  if (
    bytesHash(bytes) !== pointer.sha256 ||
    (pointer.bytes !== undefined && pointer.bytes !== bytes.length)
  )
    throw new Error("Frozen normalized capture bytes/hash mismatch");
  memoryBoundary(bytes.readUInt32LE(bytes.length - 4) * 3 + bytes.length);
  const plain = gunzipSync(bytes, { maxOutputLength: 256 * 1024 ** 2 });
  return {
    value: JSON.parse(plain.toString()) as T,
    identity: {
      pointerPath: resolve(pointerPath),
      pointerHash: bytesHash(pointerBytes),
      path: resolve(pointer.path),
      hash: pointer.sha256,
      hashMeaning:
        "hash = dereferenced compressed artifact bytes SHA256; pointerHash = pointer file bytes SHA256",
      decodedContentHash: bytesHash(plain),
      bytes: bytes.length,
      plainBytes: plain.length,
    },
  };
}
type NormalizedRow = {
  symbol: string;
  columns: (string | number)[][];
  actions?: PortfolioInstrument["actions"];
  sourceHash: string;
  adjustmentReference: string | null;
  execution?: Readonly<
    Record<string, NonNullable<ReturnType<typeof researchExecutionAt>>>
  >;
};
type ExecutionFacts = {
  bars: Bar[];
  signalBars: Bar[];
  actions: NonNullable<PortfolioInstrument["actions"]>;
  sourceHash: string;
  shardHash: string;
  execution?: PortfolioInstrument["execution"];
  origin?: unknown;
};
export function lifecycleSupplementKey(
  symbol: string,
  rawHash: string,
  configHash: string,
  first: string,
  end: string,
) {
  return contentHash({
    version: "lifecycle-tdx-supplement-1",
    symbol,
    rawHash,
    configHash,
    first,
    end,
  });
}
async function frozenGbbqSource(
  output: string,
  options: LifecycleSourceOptions,
  rawHash: string,
  configHash: string,
  frozenAt: string,
) {
  const key = contentHash({
      version: "lifecycle-gbbq-source-1",
      rawHash,
      configHash,
    }),
    index = join(output, `gbbq-${key}.json`);
  let pointer: {
    path: string;
    hash: string;
    sourcePath: string;
    sourceHash: string;
    capturedAt: string;
  };
  try {
    pointer = JSON.parse(await readFile(index, "utf8")) as typeof pointer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (options.tdxRoot === null && !options.gbbqPath)
      throw new Error("Explicit GBBQ source disabled");
    const sourcePath =
        options.gbbqPath ??
        join(options.tdxRoot ?? "E:/new_tdx64", "T0002/hq_cache/gbbq"),
      bytes = await readFile(sourcePath),
      hash = bytesHash(bytes);
    if (options.expectedGbbqHash && hash !== options.expectedGbbqHash)
      throw new Error("GBBQ initial capture bytes/hash mismatch");
    if (
      (await derivedBytes(output)) +
        (await derivedBytes(columnCacheDirectory())) +
        bytes.length >
      sourceCacheBudget
    )
      throw new LifecycleSourceBudgetError(
        "GBBQ capture exceeds512MiB source budget",
      );
    await mkdir(output, { recursive: true });
    const path = join(output, `gbbq-${hash}.bin`);
    await immutableFile(path, bytes);
    pointer = {
      path,
      hash,
      sourcePath: resolve(sourcePath),
      sourceHash: hash,
      capturedAt: frozenAt,
    };
    await immutableFile(index, JSON.stringify(pointer, null, 2));
  }
  const bytes = await readFile(pointer.path);
  if (bytesHash(bytes) !== pointer.hash)
    throw new Error("Frozen GBBQ blob changed");
  if (options.expectedGbbqHash && pointer.hash !== options.expectedGbbqHash)
    throw new Error(
      "Frozen GBBQ capture differs from explicitly selected source",
    );
  const decoded = parseGbbqFile(bytes);
  return {
    events: decoded.events,
    identity: {
      ...pointer,
      indexPath: index,
      indexHash: await hashFile(index),
      parserHash: await hashFile("packages/tstdx/src/local/gbbq.ts"),
      parserKeyHash: await hashFile("packages/tstdx/src/local/gbbq-key.ts"),
      runtimeHash: await hashFile("packages/tstdx/dist/local/gbbq.js"),
      runtimeKeyHash: await hashFile("packages/tstdx/dist/local/gbbq-key.js"),
      issues: decoded.issues,
      recordCount: decoded.recordCount,
      bias: "Current captured TDX revision, not certified historical first release",
    },
  };
}
async function frozenTdxSupplement(
  symbol: string,
  stock: Csi800Stock,
  options: LifecycleSourceOptions,
  output: string,
  rawHash: string,
  configHash: string,
  end: string,
  pendingRankBytes: number,
  gbbq: Awaited<ReturnType<typeof frozenGbbqSource>>,
) {
  const first = stock.bars[0]!.date,
    key = lifecycleSupplementKey(symbol, rawHash, configHash, first, end),
    pointerPath = join(output, `supplement-${symbol}-${key}.json`);
  let metadata: {
    captureKey: string;
    origin: unknown;
    quality: { gaps: string[] };
  };
  try {
    metadata = JSON.parse(
      await readFile(pointerPath, "utf8"),
    ) as typeof metadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const root = options.tdxRoot;
    if (root === null)
      throw new Error(
        "Supplement raw source disabled; no frozen capture exists",
      );
    const tdxRoot = root ?? "E:/new_tdx64",
      snapshot = await readBars({
        instrument: { market: "cn-equity", symbol },
        period: "day",
        adjustment: "forward",
        freezeRaw: true,
        root: tdxRoot,
        source: "local",
        live: false,
        to: end,
        now: options.now ?? Date.now(),
      });
    if (
      !snapshot.rawBars ||
      snapshot.rawBars.length !== snapshot.bars.length ||
      snapshot.rawBars.some((b, i) => b.date !== snapshot.bars[i]!.date)
    )
      throw new Error("Supplement lacks aligned original raw/forward source");
    const raw = snapshot.rawBars.filter(
        (b) => b.date >= first && b.date <= end,
      ),
      adjusted = new Map(snapshot.bars.map((b) => [b.date, b])),
      events = gbbq.events.get(symbol) ?? [];
    const actions = researchCorporateActions(
        events,
        `Frozen GBBQ ${gbbq.identity.hash}`,
        first,
        end,
      ),
      gaps: string[] = [];
    if (snapshot.barStore.priceRepaired || snapshot.sourceNote)
      gaps.push(
        `${symbol}: repaired raw supplement; ${snapshot.sourceNote ?? "price-repaired"}`,
      );
    if (raw.at(-1)?.date !== end)
      gaps.push(
        `${symbol}: missing-tail last=${raw.at(-1)?.date ?? "none"}, expected=${end}; terminal conversion/settlement not certified, no synthetic quote/cash`,
      );
    if (snapshot.barStore.formingDates.length)
      gaps.push(`${symbol}: supplement contains forming bars`);
    const execution = Object.fromEntries(
      raw.map((b, i) => [
        b.date,
        researchExecutionAt(symbol, b, raw[i - 1], actions)!,
      ]),
    );
    const row: NormalizedRow = {
      symbol,
      sourceHash: snapshot.hash,
      adjustmentReference: snapshot.barStore.adjustmentReference,
      actions,
      execution,
      columns: raw.map((b) => {
        const s = adjusted.get(b.date)!;
        return [
          b.date,
          b.open,
          b.high,
          b.low,
          b.close,
          b.volume,
          b.amount,
          s.open,
          s.high,
          s.low,
          s.close,
          s.volume,
          s.amount,
        ];
      }),
    };
    const sourcePath = join(
        tdxRoot,
        "vipdoc",
        symbol.slice(0, 2),
        "lday",
        `${symbol}.day`,
      ),
      origin = {
        kind: "tdx-supplement",
        symbol,
        first,
        end,
        sourcePath: resolve(sourcePath),
        sourceFileHash: await hashFile(sourcePath),
        snapshotHash: snapshot.hash,
        adjustmentReference: snapshot.barStore.adjustmentReference,
        gbbqPath: gbbq.identity.path,
        gbbqHash: gbbq.identity.hash,
        eventsHash: contentHash(events.filter((e) => e.date <= end)),
        executionAssumptions:
          "researchExecutionAt same-day board scenarios; historical ST/IPO/queues remain unverified",
      };
    const plain = JSON.stringify([row]),
      bytes = gzipSync(plain),
      hash = bytesHash(bytes),
      path = join(output, `supplement-${symbol}-${hash}.json.gz`);
    if (
      (await derivedBytes(output)) +
        (await derivedBytes(columnCacheDirectory())) +
        pendingRankBytes +
        bytes.length >
      sourceCacheBudget
    )
      throw new LifecycleSourceBudgetError(
        "Supplement capture exceeds512MiB source budget",
      );
    await immutableFile(path, bytes);
    const pointer = {
      path,
      sha256: hash,
      bytes: bytes.length,
      captureKey: key,
      origin,
      quality: { gaps },
    };
    await immutableFile(pointerPath, JSON.stringify(pointer, null, 2));
    metadata = pointer;
  }
  if (metadata.captureKey !== key)
    throw new Error(
      "Frozen supplement identity conflicts with original raw window",
    );
  const captured = await normalizedArtifact<NormalizedRow[]>(pointerPath);
  return {
    ...captured,
    identity: {
      ...captured.identity,
      origin: metadata.origin,
      quality: metadata.quality,
    },
  };
}
async function freezeSignalBasis(
  stocks: readonly Csi800Stock[],
  facts: Map<string, ExecutionFacts>,
  gbbq: Awaited<ReturnType<typeof frozenGbbqSource>>,
  output: string,
  rawSource: { path: string; hash: string },
  end: string,
  pendingRankBytes: number,
) {
  const origins: LifecycleSignalOrigin[] = [],
    signals = new Map<string, Bar[]>(),
    raws = new Map<string, Bar[]>(),
    missing: string[] = [];
  for (const stock of stocks) {
    memoryBoundary(stock.bars.length * 320);
    const normalized = facts.get(stock.symbol),
      union = new Map(stock.bars.map((b) => [b.date, b]));
    for (const bar of normalized?.bars ?? [])
      if (!union.has(bar.date)) union.set(bar.date, bar);
    const raw = [...union.values()].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
      startDate = stock.bars[0]!.date,
      through = raw.at(-1)!.date,
      events = gbbq.events.get(stock.symbol) ?? [];
    if (raw[0]!.date !== startDate)
      throw new Error(
        "Frozen source origin moved before declared first raw bar",
      );
    const factors = adjustmentFactors(raw, events),
      anchor = { date: startDate, factor: factors[0]!.factor },
      signalBars = applyAdjustmentAtAnchor(raw, factors, anchor);
    const tuples = barTuples(raw),
      plain = JSON.stringify(tuples),
      decodedContentHash = bytesHash(plain),
      path = join(output, `raw-${stock.symbol}-${decodedContentHash}.json.gz`);
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
      if (
        bytesHash(gunzipSync(bytes, { maxOutputLength: 128 * 1024 ** 2 })) !==
        decodedContentHash
      )
        throw new Error("Frozen source prefix conflicts with content identity");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      bytes = gzipSync(plain);
      if (
        (await derivedBytes(output)) +
          (await derivedBytes(columnCacheDirectory())) +
          pendingRankBytes +
          bytes.length >
        sourceCacheBudget
      )
        throw new LifecycleSourceBudgetError(
          "Symbol raw-prefix cache exceeds512MiB source budget",
        );
      await immutableFile(path, bytes);
    }
    const origin: LifecycleSignalOrigin = {
      symbol: stock.symbol,
      startDate,
      through,
      anchor,
      rawSource: {
        format: "bar-tuples-1",
        path,
        hash: bytesHash(bytes),
        decodedContentHash,
        upstream: normalized?.origin ?? {
          kind: "original-price",
          ...rawSource,
        },
      },
      rawPrefixHash: lifecycleRawPrefixHash(raw),
      eventsPrefixHash: contentHash(
        events.filter((e) => e.date >= startDate && e.date <= through),
      ),
      factorsPrefixHash: contentHash(factors),
      signalPrefixHash: lifecycleRawPrefixHash(signalBars),
      ...(normalized
        ? {
            legacyForwardComparisonHash: lifecycleRawPrefixHash(
              normalized.signalBars,
            ),
          }
        : {}),
    };
    origins.push(origin);
    signals.set(stock.symbol, signalBars);
    raws.set(stock.symbol, raw);
    if (normalized) {
      const oldActions = normalized.actions.filter(
        (a) => a.date >= startDate && a.date <= end,
      );
      try {
        const actions = researchCorporateActions(
            events,
            `Frozen GBBQ ${gbbq.identity.hash}`,
            startDate,
            end,
          ),
          economic = (rows: NonNullable<PortfolioInstrument["actions"]>) =>
            rows.map((a) => [
              a.date,
              a.availableAt,
              a.dividend,
              a.bonus,
              a.shareFactor ?? 1,
              a.rightsRatio ?? 0,
              a.rightsPrice ?? 0,
              a.sharesSellableAt ?? a.date,
            ]);
        if (
          contentHash(economic(oldActions)) !== contentHash(economic(actions))
        )
          missing.push(
            `actions:${stock.symbol}: frozen capture and new GBBQ economic action prefix differ; both identities retained`,
          );
        normalized.actions = actions;
      } catch (error) {
        missing.push(
          `actions:${stock.symbol}: frozen GBBQ scenario unsupported: ${error instanceof Error ? error.message : "source unavailable"}`,
        );
      }
      normalized.bars = raw;
      normalized.signalBars = signalBars;
    }
  }
  return {
    signals,
    raws,
    missing,
    proof: {
      version: "tdx-first-raw-anchor-1" as const,
      arithmetic: "rawOHLC*(F(t)/F(firstFrozenRawDate))" as const,
      factorAlgorithmHash: contentHash({
        source: gbbq.identity.parserHash,
        sourceKey: gbbq.identity.parserKeyHash,
        runtime: gbbq.identity.runtimeHash,
        runtimeKey: gbbq.identity.runtimeKeyHash,
        version: "tdx-first-raw-anchor-1",
      }),
      gbbq: gbbq.identity,
      origins,
    },
  };
}
async function normalizedExecutionSources(
  options: LifecycleSourceOptions,
  stocks: readonly Csi800Stock[],
  rawHash: string,
  configHash: string,
  end: string,
  output: string,
  pendingRankBytes: number,
  gbbq: Awaited<ReturnType<typeof frozenGbbqSource>>,
) {
  const capture = options.executionCapture ?? defaultExecutionCapture;
  const correctionBytes = await readFile(capture.correctionPath),
    correction = JSON.parse(correctionBytes.toString()) as {
      version: string;
      rawPrice: { sha256: string; symbols: number };
      preregistrationSha256: string;
      execution: {
        equitySha256: string;
        rosterSha256: string;
        symbols: number;
        equityPointerSha256?: string;
        rosterPointerSha256?: string;
        rosterScopeMismatch?: { rawOnly: string[]; captureOnly: string[] };
      };
    };
  if (
    correction.version !== "lifecycle-source-correction-1" ||
    correction.rawPrice.sha256 !== rawHash ||
    correction.rawPrice.symbols !== stocks.length ||
    correction.preregistrationSha256 !== configHash ||
    correction.execution.equitySha256 !== capture.expectedEquityHash ||
    correction.execution.rosterSha256 !== capture.expectedRosterHash ||
    correction.execution.symbols !== capture.expectedExecutionCount
  )
    throw new Error(
      "Source correction proof does not match raw/RPS/execution layers",
    );
  const equity = await normalizedArtifact<{
    eligible: string[];
    shards: string[];
    audit: { symbol: string; accepted: boolean; reason: string }[];
  }>(capture.equityPointerPath, capture.expectedEquityHash);
  const roster = await normalizedArtifact<{
    constituents: string[];
    symbols: string[];
    excluded: { symbol: string; reason: string }[];
  }>(capture.rosterPointerPath, capture.expectedRosterHash);
  if (
    (correction.execution.equityPointerSha256 &&
      correction.execution.equityPointerSha256 !==
        equity.identity.pointerHash) ||
    (correction.execution.rosterPointerSha256 &&
      correction.execution.rosterPointerSha256 !== roster.identity.pointerHash)
  )
    throw new Error(
      "Frozen normalized pointer file bytes differ from correction proof",
    );
  const sorted = (values: readonly string[]) => [...values].sort();
  if (
    contentHash(sorted(equity.value.eligible)) !==
      contentHash(sorted(roster.value.symbols)) ||
    roster.value.symbols.length !== capture.expectedExecutionCount ||
    contentHash(sorted(roster.value.excluded.map((r) => r.symbol))) !==
      contentHash(sorted(capture.excludedSymbols)) ||
    contentHash(
      sorted(
        equity.value.audit.filter((a) => !a.accepted).map((a) => a.symbol),
      ),
    ) !== contentHash(sorted(capture.excludedSymbols))
  )
    throw new Error(
      "Frozen raw800 and execution799 roster layers differ from proof",
    );
  if (
    new Set(roster.value.symbols).size !== roster.value.symbols.length ||
    new Set(equity.value.shards).size !== equity.value.shards.length ||
    equity.value.shards.some((s) => !/^equity-\d+$/.test(s))
  )
    throw new Error("Duplicate or non-equity normalized source shard");
  const originalSymbols = stocks.map((s) => s.symbol),
    rawOnly = originalSymbols.filter(
      (s) => !roster.value.constituents.includes(s),
    ),
    captureOnly = roster.value.constituents.filter(
      (s) => !originalSymbols.includes(s),
    ),
    scope = correction.execution.rosterScopeMismatch ?? {
      rawOnly: [],
      captureOnly: [],
    };
  if (
    contentHash(sorted(rawOnly)) !== contentHash(sorted(scope.rawOnly)) ||
    contentHash(sorted(captureOnly)) !== contentHash(sorted(scope.captureOnly))
  )
    throw new Error(
      "Raw/capture roster scope mismatch is not covered by approved correction",
    );
  const targetSymbols = originalSymbols.filter(
    (s) => !capture.excludedSymbols.includes(s),
  );
  if (targetSymbols.length !== capture.expectedExecutionCount)
    throw new Error("Original execution target count changed");
  const rawBySymbol = new Map(stocks.map((s) => [s.symbol, s])),
    facts = new Map<string, ExecutionFacts>(),
    missing: string[] = [],
    shards: unknown[] = [],
    audit: {
      symbol: string;
      sharedRawDates: number;
      newRawDates: number;
      rawMismatches: number;
      rawMismatchDates: string[];
      signalPolicy: string;
      sourceHash: string;
      adjustmentReference: string | null;
    }[] = [];
  const parts = [
    ...equity.value.shards.map((name) => ({ kind: "artifact" as const, name })),
    ...rawOnly
      .filter((s) => targetSymbols.includes(s))
      .map((symbol) => ({ kind: "supplement" as const, symbol })),
  ];
  for (const part of parts) {
    let shard:
      | Awaited<ReturnType<typeof normalizedArtifact<NormalizedRow[]>>>
      | Awaited<ReturnType<typeof frozenTdxSupplement>>;
    try {
      shard =
        part.kind === "artifact"
          ? await normalizedArtifact<NormalizedRow[]>(
              join(
                dirname(capture.equityPointerPath),
                `${part.name}-pointer.json`,
              ),
            )
          : await frozenTdxSupplement(
              part.symbol,
              rawBySymbol.get(part.symbol)!,
              options,
              output,
              rawHash,
              configHash,
              end,
              pendingRankBytes,
              gbbq,
            );
    } catch (error) {
      if (error instanceof LifecycleSourceBudgetError) throw error;
      if (part.kind === "artifact") throw error;
      missing.push(
        `execution:${part.symbol}: supplement unavailable: ${error instanceof Error ? error.message : "source unavailable"}`,
      );
      continue;
    }
    shards.push(shard.identity);
    if ("quality" in shard.identity) {
      const quality = shard.identity.quality as { gaps: string[] };
      missing.push(...quality.gaps);
    }
    for (const row of shard.value) {
      if (captureOnly.includes(row.symbol)) continue;
      if (
        !targetSymbols.includes(row.symbol) ||
        !rawBySymbol.has(row.symbol) ||
        facts.has(row.symbol)
      ) {
        missing.push(
          `execution:${row.symbol}: unexpected/duplicate normalized capture row`,
        );
        continue;
      }
      const original = rawBySymbol.get(row.symbol)!,
        rawDates = new Map(original.bars.map((b) => [b.date, b])),
        first = original.bars[0]?.date;
      if (!first || !Array.isArray(row.actions)) {
        missing.push(
          `execution:${row.symbol}: raw anchor or normalized actions unavailable`,
        );
        continue;
      }
      let sharedRawDates = 0,
        newRawDates = 0;
      const mismatchDates: string[] = [],
        bars: Bar[] = [],
        signalBars: Bar[] = [];
      for (const columns of row.columns) {
        const date = String(columns[0]);
        if (date < first || date > end) continue;
        if (columns.length !== 13) {
          missing.push(
            `execution:${row.symbol}:${date}: normalized OHLC columns unavailable`,
          );
          continue;
        }
        const raw: Bar = {
          date,
          open: Number(columns[1]),
          high: Number(columns[2]),
          low: Number(columns[3]),
          close: Number(columns[4]),
          volume: Number(columns[5]),
          amount: Number(columns[6]),
        };
        const prior = rawDates.get(date);
        if (prior) {
          sharedRawDates++;
          if (
            ["open", "high", "low", "close", "volume", "amount"].some(
              (key) =>
                prior[key as keyof Omit<Bar, "date">] !==
                raw[key as keyof Omit<Bar, "date">],
            )
          )
            mismatchDates.push(date);
        } else newRawDates++;
        bars.push(prior ?? raw);
        signalBars.push({
          date,
          open: Number(columns[7]),
          high: Number(columns[8]),
          low: Number(columns[9]),
          close: Number(columns[10]),
          volume: Number(columns[11]),
          amount: Number(columns[12]),
        });
      }
      orderedBars(bars, `${row.symbol}:normalized raw`);
      orderedBars(signalBars, `${row.symbol}:normalized signal`);
      const dates = new Set(bars.map((b) => b.date)),
        omitted = original.bars.filter((b) => !dates.has(b.date));
      if (omitted.length)
        missing.push(
          `execution:${row.symbol}: normalized capture omits ${omitted.length} original raw dates; dates hash ${contentHash(omitted.map((b) => b.date))}`,
        );
      if (mismatchDates.length)
        missing.push(
          `execution:${row.symbol}: ${mismatchDates.length} raw common-date mismatches; first ${mismatchDates[0]}; dates hash ${contentHash(mismatchDates)}`,
        );
      const actions = row.actions.filter((a) => a.date <= end);
      for (const action of actions)
        if (
          !action.evidence ||
          action.availableAt > action.date ||
          [
            action.dividend,
            action.bonus,
            action.rightsRatio ?? 0,
            action.rightsPrice ?? 0,
          ].some((n) => !Number.isFinite(n) || n < 0) ||
          (action.shareFactor !== undefined &&
            (!Number.isFinite(action.shareFactor) || action.shareFactor <= 0))
        )
          throw new Error(
            "Invalid normalized frozen corporate-action evidence",
          );
      facts.set(row.symbol, {
        bars,
        signalBars,
        actions,
        sourceHash: row.sourceHash,
        shardHash: shard.identity.hash,
        ...(row.execution ? { execution: row.execution } : {}),
        origin: shard.identity,
      });
      audit.push({
        symbol: row.symbol,
        sharedRawDates,
        newRawDates,
        rawMismatches: mismatchDates.length,
        rawMismatchDates: mismatchDates,
        signalPolicy:
          "Legacy frozen forward OHLC is comparison only; active signals rebuilt independently from frozen GBBQ at first raw anchor",
        sourceHash: row.sourceHash,
        adjustmentReference: row.adjustmentReference,
      });
    }
  }
  for (const symbol of targetSymbols)
    if (!facts.has(symbol))
      missing.push(`execution:${symbol}: normalized frozen source absent`);
  return {
    facts,
    executionSymbols: targetSymbols,
    missing,
    identity: {
      correctionPath: resolve(capture.correctionPath),
      correctionHash: bytesHash(correctionBytes),
      equity: equity.identity,
      roster: roster.identity,
      excluded: roster.value.excluded,
      shards,
      audit,
      rawSymbols: stocks.map((s) => s.symbol),
      executionSymbols: targetSymbols,
      rawOnly,
      captureOnly,
      reusedCaptureSymbols: targetSymbols.filter((s) =>
        roster.value.symbols.includes(s),
      ),
      supplementSymbols: rawOnly,
      rpsBasis:
        "Original800 constituent cross section; common raw dates verified and normalized-capture extra dates separately audited. All800 active signals use actual frozen GBBQ at each original first-raw anchor, with identical common endpoint eligibility for all nine periods; legacy forward columns are comparison only.",
    },
  };
}
type FrozenFinancial = {
  version: "csi800-financial-1";
  priceHash: string;
  reports: Record<string, FinancialReportSnapshot[]>;
  caps: Record<string, Record<string, number | null>>;
  seriesSources: Record<string, { hash: string }>;
};
/** Reuse the existing PIT TTM/equity numerators with actual date-matched GP16
 * market caps. Missing dates, nonpositive numerators and absent reports stay null. */
export function lifecycleFinancialValuations(
  financial: FrozenFinancial,
  symbols: readonly string[],
  calendar: readonly string[],
  sourceHash: string,
): MarketLowZoneInput["valuations"] {
  const values: MarketLowZoneInput["valuations"][number][] = [];
  for (const symbol of symbols) {
    const caps = financial.caps[symbol] ?? {},
      history = financial.reports[symbol] ?? [],
      source = `Frozen current-revision financial ${sourceHash}; PIT announcements enforced; GP16 ${financial.seriesSources[symbol]?.hash ?? "missing"}; not first-vintage certified`;
    let featureKey = "",
      features: ReturnType<typeof classicFinancialFeatures> = null;
    for (const date of calendar) {
      // Absent source dates stay absent facts; explicit null/duplicate caps
      // are retained. Neither case becomes a synthetic zero denominator.
      if (!Object.hasOwn(caps, date)) continue;
      let visible = 0,
        latest = "";
      for (const report of history)
        if (financialVisibleAt(report, date)) {
          visible++;
          if (report.reportDate > latest) latest = report.reportDate;
        }
      // Visibility is monotone in asOf. Equal visible counts identify the same
      // report set; the existing550-day freshness boundary is a separate key.
      const key = `${visible}:${(Date.parse(date) - Date.parse(latest)) / dayMs > 550}`;
      if (featureKey !== key) {
        features = classicFinancialFeatures(history, date);
        featureKey = key;
      }
      const cap = financial.caps[symbol]?.[date] ?? null;
      const positive = (value: number | null | undefined) =>
        value != null && Number.isFinite(value) && value > 0;
      const net = features?.valuationNumerators["earnings-yield"],
        equity = features?.valuationNumerators["book-to-price"];
      values.push({
        symbol,
        date,
        availableAt: date,
        marketCap: positive(cap) ? cap : null,
        pe: positive(cap) && positive(net) ? cap! / net! : null,
        pb: positive(cap) && positive(equity) ? cap! / equity! : null,
        source,
        hash: sourceHash,
      });
    }
  }
  return values;
}

/** Choose an axis from source completeness and declared warmup only. Entry,
 * depth, percentile values and portfolio outcomes never participate. */
export function lifecycleLowZoneAxis(
  input: MarketLowZoneInput | undefined,
  minimumBars: number,
  years = 10,
): LifecycleFamilyAxis {
  if (!input || !input.calendar.length)
    return axis([], ["cn-day"], minimumBars, null, [
      "low-zone: primary sh000300 source/membership absent",
    ]);
  const calendar = input.calendar,
    byDate = new Map(
      input.constituents
        .filter((s) => s.index === input.index.symbol)
        .map((s) => [s.date, s]),
    );
  const valuations = new Map<
    string,
    Map<string, MarketLowZoneInput["valuations"][number]>
  >();
  for (const fact of input.valuations) {
    if (
      Date.parse(fact.availableAt) > Date.parse(`${fact.date}T15:00:00+08:00`)
    )
      continue;
    const rows = valuations.get(fact.date) ?? new Map();
    if (rows.has(fact.symbol))
      throw new Error("Duplicate date-matched low-zone valuation source");
    rows.set(fact.symbol, fact);
    valuations.set(fact.date, rows);
  }
  const presence = new Map(
    input.stocks.map((stock) => {
      const dates = new Set(stock.bars.map((b) => b.date)),
        prefix = [0],
        first = stock.bars[0]?.date ?? "9999",
        firstIndex = calendar.findIndex((d) => d >= first);
      for (const day of calendar)
        prefix.push(prefix.at(-1)! + (dates.has(day) ? 1 : 0));
      return [stock.symbol, { first, firstIndex, prefix }] as const;
    }),
  );
  const coverage: { date: string; complete: boolean; missing: string[] }[] = [];
  let firstWindow = 0,
    validValuations = 0,
    firstValuation: string | null = null;
  const validPrefix = [0];
  for (let i = 0; i < calendar.length; i++) {
    const date = calendar[i]!,
      minimum = new Date(date),
      windowStart = new Date(date);
    minimum.setUTCFullYear(minimum.getUTCFullYear() - 5);
    windowStart.setUTCFullYear(windowStart.getUTCFullYear() - years);
    const minimumDate = minimum.toISOString().slice(0, 10),
      start = windowStart.toISOString().slice(0, 10);
    while (calendar[firstWindow]! < start) firstWindow++;
    const missing: string[] = [],
      snapshot = byDate.get(date),
      symbols =
        snapshot &&
        (snapshot.basis === "current-labelled" ||
          Date.parse(snapshot.availableAt) <=
            Date.parse(`${date}T15:00:00+08:00`))
          ? snapshot.symbols
          : [],
      facts = valuations.get(date);
    if (!symbols.length) missing.push("membership");
    const prices = symbols.filter((symbol) => {
      const source = presence.get(symbol);
      return (
        source &&
        source.first <= minimumDate &&
        source.prefix[i + 1]! - source.prefix[firstWindow]! >= minimumBars &&
        source.prefix[i + 1]! -
          source.prefix[Math.max(firstWindow, source.firstIndex)]! ===
          i + 1 - Math.max(firstWindow, source.firstIndex)
      );
    }).length;
    if (!symbols.length || prices / symbols.length < 0.6)
      missing.push("price-warmup/coverage");
    const rows = symbols.map((s) => facts?.get(s)),
      positive = (v: number | null | undefined) =>
        v != null && Number.isFinite(v) && v > 0;
    const total =
      rows.length && rows.every((r) => positive(r?.marketCap))
        ? rows.reduce((n, r) => n + r!.marketCap!, 0)
        : null;
    if (total === null) missing.push("unknown-full-membership-cap-denominator");
    for (const key of ["pe", "pb"] as const) {
      const cap = rows.reduce(
        (n, r) =>
          n +
          (positive(r?.marketCap) && positive(r?.[key]) ? r!.marketCap! : 0),
        0,
      );
      if (total === null || cap / total < 0.6)
        missing.push(`${key}-market-cap-coverage`);
    }
    const valid =
      total !== null && !missing.some((m) => m.includes("market-cap-coverage"));
    if (valid) {
      validValuations++;
      firstValuation ??= date;
    }
    validPrefix.push(validValuations);
    if (
      !firstValuation ||
      firstValuation > minimumDate ||
      validPrefix[i + 1]! - validPrefix[firstWindow]! < minimumBars
    )
      missing.push("valuation-five-year/warmup");
    if (
      input.index.bars[0]!.date > minimumDate ||
      i - firstWindow + 1 < minimumBars
    )
      missing.push("index-warmup");
    coverage.push({ date, complete: missing.length === 0, missing });
  }
  const first = coverage.findIndex((c) => c.complete);
  const missing =
    first < 0
      ? [
          "low-zone: no source-complete common axis; full CSI300 denominator/PE/PB or maximum price/valuation warmup missing",
          ...coverage
            .filter((c) => c.missing.some((m) => !m.includes("warmup")))
            .map((c) => `low-zone:${c.date}: ${c.missing.join(",")}`),
        ]
      : coverage
          .slice(first)
          .filter((c) => !c.complete)
          .map(
            (c) => `low-zone:${c.date}: ${c.missing.join(",")}; date retained`,
          );
  return axis(
    first < 0 ? [] : calendar.slice(first),
    ["cn-day"],
    minimumBars,
    calendar[0] ?? null,
    missing,
  );
}

async function frozenLowZoneIndex(
  symbol: "sh000300" | "sh000001",
  options: LifecycleSourceOptions,
  output: string,
  configHash: string,
  priceHash: string,
  frozenAt: string,
  rankPath: string,
  rankBytes: number,
): Promise<LifecycleLowZoneIndex> {
  const role = symbol === "sh000300" ? "primary" : "diagnostic",
    root = options.tdxRoot === undefined ? "E:/new_tdx64" : options.tdxRoot,
    sourcePath = root ? join(root, "vipdoc/sh/lday", `${symbol}.day`) : "",
    key = contentHash({
      version: "lifecycle-index-1",
      symbol,
      configHash,
      priceHash,
      through: "2026-11-13",
    }),
    pointerPath = join(output, `index-${symbol}-${key}.json`);
  try {
    try {
      await stat(pointerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!root) throw new Error("Explicit TDX source disabled");
      const sourceHash = await hashFile(sourcePath),
        snapshot = await readBars({
          instrument: { market: "cn-equity", symbol },
          period: "day",
          adjustment: "none",
          root,
          source: "local",
          live: false,
          to: "2026-11-13",
          now: Date.parse(frozenAt),
        });
      if ((await hashFile(sourcePath)) !== sourceHash)
        throw new Error("Index source changed during immutable capture");
      const missing: string[] = [];
      if (snapshot.barStore.formingDates.length)
        missing.push(`${symbol}: source includes forming bars`);
      if (snapshot.barStore.priceRepaired)
        missing.push(
          `${symbol}: repaired source; diagnostic price is not certified original`,
        );
      const value = {
          version: "lifecycle-index-1",
          key,
          capturedAt: frozenAt,
          symbol,
          role,
          bars: snapshot.bars,
          sourcePath,
          hash: snapshot.hash,
          sourceHash,
          missing,
          barsHash: lifecycleRawPrefixHash(snapshot.bars),
        },
        plain = JSON.stringify(value),
        bytes = gzipSync(plain),
        hash = bytesHash(bytes),
        path = join(output, `index-${symbol}-${hash}.json.gz`);
      await sourceDiskBoundary(
        output,
        rankPath,
        rankBytes,
        bytes.length + 1024,
      );
      await immutableFile(path, bytes);
      await immutableFile(
        pointerPath,
        JSON.stringify({ path, sha256: hash, bytes: bytes.length }, null, 2),
      );
    }
    const archive = await normalizedArtifact<
      LifecycleLowZoneIndex & { version: string; key: string; barsHash: string }
    >(pointerPath);
    if (
      archive.value.version !== "lifecycle-index-1" ||
      archive.value.key !== key ||
      archive.value.symbol !== symbol ||
      lifecycleRawPrefixHash(archive.value.bars) !== archive.value.barsHash
    )
      throw new Error("Frozen index capture identity mismatch");
    orderedBars(archive.value.bars, `${symbol}:immutable index`);
    const { bars, hash, sourceHash, missing } = archive.value;
    return {
      symbol,
      role,
      bars,
      hash,
      sourceHash,
      sourcePath: archive.value.sourcePath,
      missing,
      archive: archive.identity,
    };
  } catch (error) {
    if (error instanceof LifecycleSourceBudgetError) throw error;
    // Existing immutable identities must fail closed instead of resampling E:.
    try {
      await stat(pointerPath);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ENOENT") throw probe;
      return {
        symbol,
        role,
        bars: [],
        sourcePath,
        hash: contentHash({ symbol, unavailable: true }),
        sourceHash: "",
        missing: [
          `${symbol}: ${error instanceof Error ? error.message : "source unavailable"}`,
        ],
      };
    }
    throw error;
  }
}

async function readFinancialValuations(
  financial: { path: string; hash: string },
  priceHash: string,
  symbols: readonly string[],
  calendar: readonly string[],
  stage: SourceStage,
) {
  await stage("financial:before-decode");
  const facts = await verifiedSourceJson<FrozenFinancial>(
    financial.path,
    financial.hash,
    { maxOutputLength: 768 * 1024 ** 2 },
  );
  await stage("financial:decoded");
  if (
    facts.version !== "csi800-financial-1" ||
    facts.priceHash !== priceHash ||
    !facts.reports ||
    !facts.caps ||
    !facts.seriesSources
  )
    throw new Error("Frozen low-zone financial source identity/shape mismatch");
  const selected = new Set(symbols);
  for (const map of [facts.caps, facts.reports, facts.seriesSources])
    for (const symbol of Object.keys(map))
      if (!selected.has(symbol)) delete map[symbol];
  await stage("financial:selected-membership");
  const values: MarketLowZoneInput["valuations"][number][] = [];
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    values.push(
      ...lifecycleFinancialValuations(
        facts,
        [symbol],
        calendar,
        financial.hash,
      ),
    );
    delete facts.caps[symbol];
    delete facts.reports[symbol];
    delete facts.seriesSources[symbol];
    if (i % 50 === 49) await stage(`financial:projected-${i + 1}`);
  }
  await stage("financial:projected");
  return values;
}

async function captureLowZoneSources(
  options: LifecycleSourceOptions,
  financial: { path: string; hash: string },
  priceHash: string,
  sourceEnd: string,
  stocks: readonly Csi800Stock[],
  signals: readonly (readonly Bar[])[],
  frozenAt: string,
  output: string,
  configHash: string,
  rankPath: string,
  rankBytes: number,
  stage: SourceStage,
) {
  const indices: LifecycleLowZoneIndex[] = [];
  for (const symbol of ["sh000300", "sh000001"] as const) {
    indices.push(
      await frozenLowZoneIndex(
        symbol,
        options,
        output,
        configHash,
        priceHash,
        frozenAt,
        rankPath,
        rankBytes,
      ),
    );
  }
  let membership: LifecycleSourceBundle["lowZoneSources"]["membership"] = null;
  const membershipPath =
    options.lowZoneMembershipPath === undefined
      ? defaultLowMembership
      : options.lowZoneMembershipPath;
  if (membershipPath) {
    const bytes = await readFile(membershipPath),
      hash = bytesHash(bytes),
      expected =
        options.expectedLowZoneMembershipHash ??
        (membershipPath === defaultLowMembership
          ? defaultLowMembershipHash
          : undefined);
    if (expected && expected !== hash)
      throw new Error("Frozen primary CSI300 membership hash mismatch");
    membership = {
      path: membershipPath,
      hash,
      symbols: parseIndustryMembers(bytes, membershipPath),
      basis: "current-labelled",
    };
  }
  const primary = indices.find((i) => i.role === "primary")!,
    commonIndexBars = primary.bars.filter((b) => b.date <= sourceEnd),
    calendar = commonIndexBars.map((b) => b.date),
    missing = [...primary.missing];
  if (!membership)
    missing.push(
      "primary sh000300 current-labelled membership source absent; no CSI800 substitution",
    );
  const sourcePool = new Set(stocks.map((s) => s.symbol)),
    outsidePool = membership?.symbols.filter((s) => !sourcePool.has(s)) ?? [];
  if (outsidePool.length)
    missing.push(
      `membership: full current CSI300 includes symbols outside frozen original price pool: ${outsidePool.join(",")}; denominator retained`,
    );
  let valuations: MarketLowZoneInput["valuations"] = [],
    decoded = false;
  if (options.decodeLowZoneFinancials) {
    valuations = await readFinancialValuations(
      financial,
      priceHash,
      membership?.symbols ?? [],
      calendar,
      stage,
    );
    decoded = true;
  } else
    missing.push(
      "financial: original csi800-financial-1 has PIT reports, date-matched caps and GP16 source hashes; full frozen financial decode deferred to the explicit source resource gate",
    );
  const sourceInfo = {
    indices,
    membership,
    financial: {
      ...financial,
      format:
        "csi800-financial-1: reports[symbol][] PIT dates; caps[symbol][date] positive-MV/null; seriesSources[symbol].hash (original GP16)",
      decoded,
      missing,
    },
  };
  const stockSymbols = new Set(membership?.symbols ?? []);
  const input: MarketLowZoneInput | undefined =
    membership && primary.bars.length
      ? {
          calendar,
          index: {
            symbol: "sh000300",
            bars: commonIndexBars,
            source: `TDX original local ${primary.sourcePath}`,
            hash: primary.sourceHash,
          },
          stocks: stocks.flatMap((stock, i) =>
            stockSymbols.has(stock.symbol)
              ? [
                  {
                    symbol: stock.symbol,
                    bars: signals[i]!,
                    source: `Frozen classic causal signal history ${priceHash}`,
                    hash: priceHash,
                  },
                ]
              : [],
          ),
          constituents: calendar.map((date) => ({
            index: "sh000300" as const,
            date,
            availableAt: frozenAt,
            source: `Current CSI300 membership ${membership.path}; lookahead sensitivity only`,
            hash: membership.hash,
            symbols: membership.symbols,
            basis: "current-labelled" as const,
          })),
          valuations,
        }
      : undefined;
  return { sourceInfo, input };
}
function orderedBars(bars: readonly Bar[], source: string) {
  let previous = "";
  for (const bar of bars) {
    if (
      !Number.isFinite(Date.parse(bar.date)) ||
      bar.date <= previous ||
      ![bar.open, bar.high, bar.low, bar.close].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      bar.high < Math.max(bar.open, bar.close, bar.low) ||
      bar.low > Math.min(bar.open, bar.close) ||
      !Number.isFinite(bar.volume) ||
      bar.volume < 0
    )
      throw new Error(`Invalid/duplicate/out-of-order source bars: ${source}`);
    previous = bar.date;
  }
}

type RpsView = {
  periods: readonly number[];
  ranks: Float32Array;
  closes: Float64Array;
  counts: Uint16Array;
  dates: number;
  width: number;
  longest: number;
};
/** One shared accessor instead of a closure for each symbol/date. */
class LifecycleRpsPoint implements FormulaRpsPoint {
  readonly periods: readonly number[];
  #view: RpsView;
  #symbol: number;
  #day: number;
  constructor(
    readonly date: string,
    view: RpsView,
    symbol: number,
    day: number,
  ) {
    this.periods = view.periods;
    this.#view = view;
    this.#symbol = symbol;
    this.#day = day;
    Object.defineProperty(this, "values", {
      enumerable: true,
      get: lifecycleRpsValuesGetter,
    });
  }
  get values(): FormulaRpsPoint["values"] {
    const v = this.#view,
      s = this.#symbol,
      d = this.#day;
    return v.periods.map((period, p) => {
      const rank = v.ranks[(s * v.dates + d) * v.periods.length + p]!;
      return Number.isNaN(rank)
        ? null
        : {
            return:
              v.closes[s * v.width + d + v.longest]! /
                v.closes[s * v.width + d + v.longest - period]! -
              1,
            rank,
            rps: (1 - rank / v.counts[d]!) * 100,
          };
    });
  }
  toJSON() {
    return { date: this.date, periods: this.periods, values: this.values };
  }
}
const lifecycleRpsValuesGetter = Object.getOwnPropertyDescriptor(
  LifecycleRpsPoint.prototype,
  "values",
)!.get!;

/** Same frozen cross section for every registered rank period. NaN in the
 * compact matrix means missing evidence, never a zero rank or zero return. */
export function buildLifecycleRps(
  stocks: readonly Csi800Stock[],
  calendar: readonly string[],
  periods: readonly number[] = lifecycleRpsPeriods,
  unknownSignals: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
) {
  if (
    !periods.length ||
    stocks.length > 10000 ||
    periods.some((p) => !Number.isInteger(p) || p < 1) ||
    new Set(periods).size !== periods.length ||
    new Set(stocks.map((s) => s.symbol)).size !== stocks.length ||
    new Set(calendar).size !== calendar.length ||
    calendar.some((d, i) => i > 0 && d <= calendar[i - 1]!)
  )
    throw new Error("Invalid lifecycle RPS pool/calendar/periods");
  const longest = Math.max(...periods),
    dates = calendar.slice(longest),
    width = calendar.length;
  const projected =
    stocks.length * width * 2 * 8 +
    stocks.length * dates.length * periods.length * 4;
  if (projected > sourceCacheBudget)
    throw new Error("Lifecycle RPS compact cache exceeds512MiB");
  const pointMetadata = stocks.length * dates.length * 96;
  const causalBars = stocks.reduce(
    (n, stock) => n + (stock.signalBars ? 0 : stock.bars.length * 128),
    0,
  );
  memoryBoundary(projected + pointMetadata + causalBars);
  const closes = new Float64Array(stocks.length * width).fill(NaN),
    volumes = new Float64Array(stocks.length * width).fill(NaN);
  const indices = new Map(calendar.map((d, i) => [d, i]));
  const signals = stocks.map((stock, s) => {
    orderedBars(stock.bars, stock.symbol);
    const bars = stock.signalBars ?? csi800SignalBars(stock);
    orderedBars(bars, `${stock.symbol}:signals`);
    if (
      bars.length !== stock.bars.length ||
      bars.some((b, i) => b.date !== stock.bars[i]!.date)
    )
      throw new Error("Raw and causal signal source dates differ");
    for (const bar of bars) {
      const i = indices.get(bar.date);
      if (i !== undefined) {
        closes[s * width + i] = bar.close;
        volumes[s * width + i] = bar.amount > 0 ? bar.volume : 0;
      }
    }
    return bars;
  });
  const ranks = new Float32Array(
      stocks.length * dates.length * periods.length,
    ).fill(NaN),
    counts = new Uint16Array(dates.length);
  const audits: { date: string; eligible: number; excluded: number }[] = [];
  for (let d = 0; d < dates.length; d++) {
    const i = d + longest;
    const eligible = stocks.flatMap((stock, s) => {
      const offset = s * width,
        current = closes[offset + i]!;
      const valid =
        current > 0 &&
        volumes[offset + i]! > 0 &&
        periods.every(
          (p) => closes[offset + i - p]! > 0 && volumes[offset + i - p]! > 0,
        ) &&
        ![calendar[i]!, ...periods.map((p) => calendar[i - p]!)].some((d) =>
          unknownSignals.get(stock.symbol)?.has(d),
        ) &&
        !stock.actions.some(
          (a) =>
            a.unsupported &&
            a.date > calendar[i - longest]! &&
            a.date <= calendar[i]!,
        );
      return valid ? [s] : [];
    });
    counts[d] = eligible.length;
    for (let p = 0; p < periods.length; p++) {
      const values = eligible.map((s) => ({
        symbol: stocks[s]!.symbol,
        return:
          closes[s * width + i]! / closes[s * width + i - periods[p]!]! - 1,
      }));
      const ranked = rankRps(values);
      for (const s of eligible)
        ranks[(s * dates.length + d) * periods.length + p] = ranked.get(
          stocks[s]!.symbol,
        )!.rank;
    }
    audits.push({
      date: dates[d]!,
      eligible: eligible.length,
      excluded: stocks.length - eligible.length,
    });
  }
  const rpsBySymbol = new Map<string, readonly FormulaRpsPoint[]>();
  const view: RpsView = {
    periods,
    ranks,
    closes,
    counts,
    dates: dates.length,
    width,
    longest,
  };
  stocks.forEach((stock, s) => {
    if (s % 32 === 0) memoryBoundary();
    const points = dates.map(
      (date, d) => new LifecycleRpsPoint(date, view, s, d),
    );
    rpsBySymbol.set(stock.symbol, points);
  });
  const rankBytes = Buffer.from(
    ranks.buffer,
    ranks.byteOffset,
    ranks.byteLength,
  );
  const symbolIndices = new Map(stocks.map((stock, i) => [stock.symbol, i]));
  return {
    signals,
    rpsBySymbol,
    rankBytes,
    isEligible: (symbol: string, date: string) => {
      const s = symbolIndices.get(symbol),
        i = indices.get(date);
      return (
        s !== undefined &&
        i !== undefined &&
        i >= longest &&
        !Number.isNaN(ranks[(s * dates.length + i - longest) * periods.length]!)
      );
    },
    audit: {
      version: "lifecycle-rps-1",
      algorithm:
        "quant-rps.rankRps (registered rankReturns name); average-one-based ties",
      periods: [...periods],
      pool: stocks.map((s) => s.symbol),
      poolHash: contentHash(stocks.map((s) => s.symbol)),
      calendarHash: contentHash(calendar),
      rankHash: bytesHash(rankBytes),
      layout:
        "Float32LE[symbol,date-after-max-warmup,period]; exact integer/half-integer ranks <=10000 only; RPS/returns reconstructed in Float64; NaN=excluded for all periods",
      dates: [...dates],
      coverage: audits,
      eligibility:
        "Every period uses the same common pool with positive-turnover, positive-price endpoints for ALL registered periods; source history is a conservative listing-age proxy; no historical ST claim",
      compactBytes: projected,
    },
  };
}

/** Daily source labels identify openings. 4h labels are exact END boundaries;
 * a UTC day is complete only with 04/08/12/16/20/next00, including midnight. */
export function lifecycleCryptoCoverage(
  bars: readonly Bar[],
  period: "day" | "4h",
) {
  orderedBars(bars, `crypto-${period}`);
  const groups = new Map<string, Set<number>>();
  for (const bar of bars) {
    const time = Date.parse(bar.date),
      completion = period === "day" ? time + dayMs : time,
      step = period === "day" ? dayMs : 4 * 3600000;
    if (time % step !== 0) throw new Error("Off-grid native crypto source");
    const date = new Date(completion - 1).toISOString().slice(0, 10),
      values = groups.get(date) ?? new Set<number>();
    values.add(completion);
    groups.set(date, values);
  }
  const complete = [...groups]
    .filter(([date, times]) => {
      const start = Date.parse(date),
        step = period === "day" ? dayMs : 4 * 3600000;
      return Array.from(
        { length: dayMs / step },
        (_, i) => start + (i + 1) * step,
      ).every((t) => times.has(t));
    })
    .map(([d]) => d)
    .sort();
  const observed = [...groups.keys()].sort();
  const days = observed.length
    ? naturalDays(observed[0]!, observed.at(-1)!)
    : [];
  const completed = new Set(complete);
  return {
    complete,
    missing: days.filter((d) => !completed.has(d)),
    first: complete[0] ?? null,
    last: complete.at(-1) ?? null,
  };
}

type RegistrationMain = {
  id: string;
  family: string;
  strategy: StrategyObjectInput;
  detector?: { years: number; minimumBars: number };
};
type Registration = {
  main: RegistrationMain[];
  neighbors: {
    parent: string;
    family: string;
    patch: Record<string, number | number[]>;
  }[];
  families: { family: string }[];
  rankSource: { periods: number[] };
  axes: { cnSwing: { start: string; end: string }; crypto: { end: string } };
  resources: { mutableOutputRoot: string };
};
function familyWarmup(config: Registration, family: string) {
  const rows = config.main.filter((m) => m.family === family);
  let days = 61;
  for (const row of rows) {
    const values: number[] = [61];
    const scan = (value: unknown, key = "") => {
      if (Array.isArray(value)) {
        if (key === "periods")
          values.push(
            ...value
              .filter((n): n is number => typeof n === "number")
              .map((n) => n + 1),
          );
        else value.forEach((v) => scan(v, key));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) scan(v, k);
      } else if (
        typeof value === "number" &&
        [
          "slow",
          "fast",
          "lookback",
          "atrPeriod",
          "period",
          "N1",
          "minimumBars",
        ].includes(key)
      )
        values.push(key === "minimumBars" ? value : value + 1);
    };
    scan(row.strategy);
    scan(row.detector);
    for (const neighbor of config.neighbors.filter((n) => n.parent === row.id))
      for (const [key, value] of Object.entries(neighbor.patch))
        scan(value, key.split(".").at(-1));
    const bars = Math.max(...values),
      technicalDays = row.strategy.period === "4h" ? Math.ceil(bars / 6) : bars;
    days = Math.max(days, technicalDays);
  }
  return days;
}

function axis(
  dailyAxis: string[],
  sourceKeys: LifecycleSourceKey[],
  warmupBars: number,
  warmupStart: string | null,
  missing: string[],
  firstSignal?: string,
  targetThrough = dailyAxis.at(-1) ?? null,
): LifecycleFamilyAxis {
  const evidence = {
    dailyAxis,
    sourceKeys,
    warmupBars,
    warmupStart,
    missing,
    firstSignal,
    targetThrough,
    valuationThrough: dailyAxis.at(-1) ?? null,
  };
  return { ...evidence, axisHash: contentHash(evidence) };
}
async function immutableFile(path: string, bytes: Uint8Array | string) {
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await hashFile(path)) !== bytesHash(bytes))
      throw new Error("Frozen source sidecar/cache identity conflict");
  }
}

let loaded: { key: string; bundle: Promise<LifecycleSourceBundle> } | undefined;
/** Source-only load. Native readers authenticate their durable files; no venue
 * fetch, production settings read, trial execution or result-based axis choice. */
export function loadLifecycleSource(
  configPath = "research/configs/l3.json",
  options: LifecycleSourceOptions = {},
): Promise<LifecycleSourceBundle> {
  const key = JSON.stringify([resolve(configPath), options]);
  if (loaded?.key === key) return loaded.bundle;
  if (loaded)
    throw new Error(
      "One shared lifecycle source per process; start a separate isolated fixture process for another source",
    );
  const bundle = readLifecycleSource(configPath, options).catch(
    (error: unknown) => {
      if (loaded?.key === key) loaded = undefined;
      throw error;
    },
  );
  loaded = { key, bundle };
  return bundle;
}

async function readLifecycleSource(
  configPath: string,
  options: LifecycleSourceOptions,
): Promise<LifecycleSourceBundle> {
  const isolated = process.env.QUANT_DATA_DIR;
  if (!isolated || !isAbsolute(isolated))
    throw new Error("Explicit isolated absolute QUANT_DATA_DIR required");
  const configBytes = await readFile(configPath),
    configHash = bytesHash(configBytes);
  if (configHash !== (options.expectedConfigHash ?? lifecycleConfigHash))
    throw new Error("Frozen lifecycle registration bytes changed");
  const config = JSON.parse(configBytes.toString()) as Registration;
  if (
    contentHash(config.rankSource.periods) !== contentHash(lifecycleRpsPeriods)
  )
    throw new Error("Registered RPS periods changed");
  const output = resolve(
    options.outputRoot ?? join(config.resources.mutableOutputRoot, "source"),
  );
  const authorized = [
    resolve(isolated),
    resolve(".test-data/lifecycle-20261116/l3"),
  ].some((root) => {
    const child = relative(root, output);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!authorized)
    throw new Error(
      "Source cache must stay within the task's isolated output roots",
    );
  const stage: SourceStage = async (name) => {
    const memory = process.memoryUsage();
    await mkdir(dirname(output), { recursive: true });
    await appendFile(
      join(dirname(output), "source-memory.jsonl"),
      JSON.stringify({
        stage: name,
        at: new Date().toISOString(),
        pid: process.pid,
        ...memory,
        nativeMaxRss: process.resourceUsage().maxRSS * 1024,
        limitBytes: processBudget,
      }) + "\n",
    );
    memoryBoundary();
  };
  await stage("source:start");
  const frozenAt = new Date(options.now ?? Date.now()).toISOString();
  const manifestPath = resolve(
    options.classicManifestPath ??
      ".data/csi800-factors-20261108-115614/manifest.json",
  );
  const reconstructionPath = resolve(
    options.reconstructionPath ??
      ".test-data/lifecycle-20261116/oracle/reconstruction-manifest.json",
  );
  const [manifestBytes, reconstructionBytes] = await Promise.all([
    readFile(manifestPath),
    readFile(reconstructionPath),
  ]);
  const manifest = JSON.parse(manifestBytes.toString()) as {
    inputs: {
      pricePath: string;
      priceHash: string;
      financial: { path: string; fileHash: string };
    };
    panel: { path: string; fileHash: string; contentHash: string };
    commonStart: string;
    firstSignal: string;
  };
  const oracle = JSON.parse(reconstructionBytes.toString()) as {
    sourceManifestHash: string;
    inputHashes: { path: string; hash: string }[];
    panelContentHash: string;
    commonStart: string;
    firstSignal: string;
    finalDate: string;
  };
  if (
    oracle.sourceManifestHash !== bytesHash(manifestBytes) ||
    oracle.panelContentHash !== manifest.panel.contentHash ||
    oracle.commonStart !== manifest.commonStart ||
    oracle.firstSignal !== manifest.firstSignal
  )
    throw new Error("Classic oracle/source manifest mismatch");
  const files = [
    { path: manifest.inputs.pricePath, hash: manifest.inputs.priceHash },
    { path: manifest.panel.path, hash: manifest.panel.fileHash },
    {
      path: manifest.inputs.financial.path,
      hash: manifest.inputs.financial.fileHash,
    },
  ];
  for (const file of files) {
    if (
      !oracle.inputHashes.some(
        (f) => resolve(f.path) === resolve(file.path) && f.hash === file.hash,
      ) ||
      (await hashFile(file.path)) !== file.hash
    )
      throw new Error(`Frozen classic source hash mismatch: ${file.path}`);
  }
  const price = await verifiedSourceJson<{
    stocks: Csi800Stock[];
    benchmark: Bar[];
    end: string;
  }>(files[0]!.path, files[0]!.hash);
  await stage("price:parsed");
  if (price.stocks.length !== (options.expectedRawPoolSize ?? 800))
    throw new Error(
      "Frozen original raw CSI800 price-pool size differs from exact source identity",
    );
  orderedBars(price.benchmark, "cn benchmark");
  const weeks = await verifiedSourceJson<ClassicWeek[]>(
    manifest.panel.path,
    manifest.panel.fileHash,
    { maxOutputLength: 1024 ** 3, contentHash: manifest.panel.contentHash },
  );
  await stage("panel:parsed");
  if (
    !weeks.some((w) => w.date === manifest.firstSignal) ||
    !weeks.some((w) => w.date === oracle.finalDate)
  )
    throw new Error(
      "Classic first signal/final target absent from source panel",
    );
  const cnCalendar = price.benchmark.map((b) => b.date);
  if (
    config.axes.cnSwing.start !== manifest.commonStart ||
    config.axes.cnSwing.end !== price.end ||
    cnCalendar.indexOf(manifest.firstSignal) < 0 ||
    cnCalendar.indexOf(manifest.commonStart) !==
      cnCalendar.indexOf(manifest.firstSignal) + 1 ||
    oracle.finalDate > price.end
  )
    throw new Error(
      "Declared CN first-signal/first-fill/target/valuation source boundaries differ",
    );
  const baselineRisk = price.stocks.map((stock) => ({
    symbol: stock.symbol,
    bars: csi800SignalBars(stock).map(({ date, close }) => ({ date, close })),
  }));
  await stage("baseline:compact");
  const pendingRankBytes =
    price.stocks.length *
    Math.max(0, cnCalendar.length - Math.max(...lifecycleRpsPeriods)) *
    lifecycleRpsPeriods.length *
    4;
  const gbbq = await frozenGbbqSource(
    output,
    options,
    manifest.inputs.priceHash,
    configHash,
    frozenAt,
  );
  const normalized = await normalizedExecutionSources(
    options,
    price.stocks,
    manifest.inputs.priceHash,
    configHash,
    price.end,
    output,
    pendingRankBytes,
    gbbq,
  );
  await stage("execution:normalized");
  const basis = await freezeSignalBasis(
    price.stocks,
    normalized.facts,
    gbbq,
    output,
    files[0]!,
    price.end,
    pendingRankBytes,
  );
  await stage("signals:first-anchor");
  const causalStocks = price.stocks.map((stock) => ({
    ...stock,
    bars: basis.raws.get(stock.symbol)!,
    signalBars: basis.signals.get(stock.symbol)!,
    actions: [],
  }));
  const rps = buildLifecycleRps(causalStocks, cnCalendar, lifecycleRpsPeriods);
  await stage("rps:shared-view");
  const cnMissing: string[] = [...normalized.missing, ...basis.missing];
  type Status = {
    symbol: string;
    suspensionFrom: string;
    suspensionNoticePublishedOn?: string;
    suspensionSource: string;
    listingEndsOn: string;
    listingNoticePublishedOn: string;
    listingSource: string;
    classification: string;
  };
  const statusPath =
    options.terminalStatusPath === undefined
      ? ".test-data/lifecycle-20261116/l3/terminal-status-evidence.json"
      : options.terminalStatusPath;
  const statusBytes = statusPath ? await readFile(statusPath) : null,
    status = statusBytes
      ? (JSON.parse(statusBytes.toString()) as {
          version: string;
          events: Status[];
        })
      : null;
  if (status && status.version !== "lifecycle-terminal-status-evidence-1")
    throw new Error("Terminal status evidence schema differs");
  const statuses = new Map(
    status?.events.map((event) => [event.symbol, event]) ?? [],
  );
  for (let i = 0; i < cnMissing.length; i++) {
    const event = status?.events.find((e) =>
      cnMissing[i]!.startsWith(`${e.symbol}: missing-tail`),
    );
    if (event)
      cnMissing[i] =
        `${event.symbol}: known suspension effective ${event.suspensionFrom}; termination notice ${event.listingNoticePublishedOn}, effective ${event.listingEndsOn}; unsupported merger conversion/settlement accounting, raw tail retained without synthetic cash/quotes; ${event.listingSource}`;
  }
  let industries: StrategyBookFacts["industries"];
  let industryIdentity: unknown = null;
  const industryRoot =
    options.industryRoot === undefined
      ? defaultIndustryRoot
      : options.industryRoot;
  if (industryRoot) {
    const industry = await readIndustryBlocks(industryRoot);
    const expected =
      options.expectedIndustryHash ??
      (industryRoot === defaultIndustryRoot ? defaultIndustryHash : undefined);
    if (expected && industry.hash !== expected)
      throw new Error("Frozen industry Blocks source hash mismatch");
    industryIdentity = industry;
    const groups = new Map<string, Set<string>>();
    for (const file of industry.files)
      for (const symbol of file.members) {
        const names = groups.get(symbol) ?? new Set<string>();
        names.add(file.name);
        groups.set(symbol, names);
      }
    const date = new Date(Math.max(...industry.files.map((f) => f.mtimeMs)))
      .toISOString()
      .slice(0, 10);
    industries = [...groups].map(([symbol, names]) => ({
      symbol,
      date,
      availableAt: date,
      groups: [...names].sort(),
      source: `current Blocks full membership ${industry.hash}`,
      basis: "current" as const,
    }));
  } else
    cnMissing.push(
      "industry: no frozen current-labelled industry source/hash supplied",
    );
  const cnInstruments = normalized.executionSymbols.flatMap((symbol) => {
    const facts = normalized.facts.get(symbol);
    if (!facts) return [];
    return [
      {
        symbol,
        market: "cn-equity" as const,
        bars: facts.bars,
        signalBars: facts.signalBars,
        actions: facts.actions,
        external: { rps: rps.rpsBySymbol.get(symbol)! },
        execution:
          facts.execution ??
          ((
            bar: Readonly<Bar> | undefined,
            previous: Readonly<Bar> | undefined,
          ) => researchExecutionAt(symbol, bar, previous, facts.actions)),
      },
    ];
  });
  const longest = Math.max(...lifecycleRpsPeriods);
  const admissionSources = cnInstruments.map((instrument) => {
    const bars = new Map(instrument.bars.map((b) => [b.date, b])),
      first = instrument.bars[0]?.date,
      firstIndex = first ? cnCalendar.findIndex((d) => d >= first) : -1,
      prefix = [0];
    for (const d of cnCalendar)
      prefix.push(prefix.at(-1)! + (bars.has(d) ? 0 : 1));
    return { symbol: instrument.symbol, bars, firstIndex, prefix };
  });
  const admissionAudit: {
    date: string;
    preObservationOrWarmup: string[];
    knownNoTurnover: string[];
    knownStatusUnavailable: string[];
    unknown: string[];
  }[] = [];
  const memberships = cnCalendar.map((date, i) => {
    const symbols: string[] = [],
      preObservationOrWarmup: string[] = [],
      knownNoTurnover: string[] = [],
      knownStatusUnavailable: string[] = [],
      unknown: string[] = [];
    for (const source of admissionSources) {
      if (source.firstIndex < 0 || i < source.firstIndex + longest) {
        preObservationOrWarmup.push(source.symbol);
        continue;
      }
      const observedStatus = statuses.get(source.symbol),
        knownAt =
          observedStatus?.suspensionNoticePublishedOn ??
          observedStatus?.listingNoticePublishedOn;
      if (
        observedStatus &&
        knownAt &&
        date >= knownAt &&
        date >= observedStatus.suspensionFrom
      ) {
        knownStatusUnavailable.push(
          `${source.symbol}: ${date >= observedStatus.listingEndsOn ? "unsupported-conversion-after-listing-end" : "known-suspension"}; knownAt=${knownAt}; effectiveFrom=${observedStatus.suspensionFrom}`,
        );
        continue;
      }
      const bar = source.bars.get(date),
        start = Math.max(source.firstIndex, i - longest),
        missingWindow = source.prefix[i + 1]! - source.prefix[start]!;
      if (!bar || missingWindow > 0) {
        unknown.push(
          `${source.symbol}: source hole in required structure/endpoint window`,
        );
        continue;
      }
      if (!rps.isEligible(source.symbol, date)) {
        const endpoints = [
          date,
          ...lifecycleRpsPeriods.map((p) => cnCalendar[i - p]!),
        ].map((d) => source.bars.get(d));
        if (endpoints.some((b) => !b))
          unknown.push(`${source.symbol}: missing declared RPS endpoint`);
        else if (endpoints.some((b) => b!.volume <= 0 || b!.amount <= 0))
          knownNoTurnover.push(source.symbol);
        else
          unknown.push(
            `${source.symbol}: normalized RPS adjustment not proved`,
          );
        continue;
      }
      symbols.push(source.symbol);
    }
    admissionAudit.push({
      date,
      preObservationOrWarmup,
      knownNoTurnover,
      knownStatusUnavailable,
      unknown,
    });
    return {
      strategyId: "lifecycle-source-cn",
      date,
      availableAt: date,
      symbols,
      basis: "current-labelled",
      source:
        "Frozen execution799 mask plus source-only common132 warmup/endpoint eligibility; not historical IPO or PIT membership certification",
    };
  });
  for (const row of admissionAudit)
    if (row.date >= manifest.firstSignal && row.unknown.length)
      cnMissing.push(
        `eligibility:${row.date}: ${row.unknown.join(";")}; date retained`,
      );
  const cnIdentity = {
    files,
    manifestHash: bytesHash(manifestBytes),
    reconstructionHash: bytesHash(reconstructionBytes),
    industry: industryIdentity,
    rps: rps.audit,
    normalized: normalized.identity,
    signalBasis: basis.proof,
    terminalStatus:
      statusPath && statusBytes
        ? {
            path: resolve(statusPath),
            hash: bytesHash(statusBytes),
            evidence: status,
            availabilityPolicy:
              "Daily admission uses only proven suspension publication dates; absent suspension publication uses the proven listing-notice date conservatively. Later status retrieval never backdates historical knowledge. Conversion and terminal accounting remain unsupported.",
          }
        : null,
    baselineRisk: {
      source: manifest.inputs.priceHash,
      originalSymbols: price.stocks.map((s) => s.symbol),
      policy:
        "Original800 csi800SignalBars and original actions; normalized actions never rewrite BASE risk",
      signalAlgorithmHash: await hashFile(
        "packages/trading-strategies/src/csi800-signal.ts",
      ),
    },
    admission: {
      strategyId: "lifecycle-source-cn",
      rowHash: contentHash(memberships),
      audit: admissionAudit,
      basis:
        "current-labelled execution snapshot; pre-first-observation/technical warmup is known not eligible, an internal history hole is unknown",
    },
    costs: {
      ...marketRules["cn-equity"].costs!,
      sellTaxSchedule: { kind: "cn-equity-historical" as const, multiplier: 1 },
    },
  };
  const cn: LifecycleMarketSource = {
    request: {
      market: "cn-equity",
      initial: 1000000,
      calendar: cnCalendar,
      instruments: cnInstruments,
      memberships,
      costs: cnIdentity.costs,
    },
    benchmark: price.benchmark,
    bookFacts: {
      benchmark: { symbol: "sh000906", bars: price.benchmark },
      classicWeeks: weeks,
      classicRiskSeries: baselineRisk,
      ...(industries ? { industries } : {}),
    },
    inputHash: contentHash(cnIdentity),
    source: `classic raw800 ${manifestPath}; RPS same800 cross section; separately frozen normalized799 execution mask`,
    missing: cnMissing,
    rawUniverse: {
      symbols: price.stocks.map((s) => s.symbol),
      source: `Original frozen CSI800-labelled roster; effective membership date uncertified; three-in/three-out versus later R2a5 roster; ${manifest.inputs.pricePath}`,
      hash: manifest.inputs.priceHash,
    },
    executionUniverse: {
      symbols: normalized.executionSymbols,
      source:
        "Original raw800 minus frozen831 exclusion; target799 unchanged, distinct from later capture-directory roster",
      hash: contentHash(normalized.executionSymbols),
    },
    signalBasis: basis.proof,
  };
  const projectedRankPath = join(output, `ranks-${rps.audit.rankHash}.f32`);
  await stage("admission:built");
  let indexCacheEstimate = 0;
  const sourceTdxRoot =
    options.tdxRoot === undefined ? "E:/new_tdx64" : options.tdxRoot;
  if (sourceTdxRoot)
    for (const symbol of ["sh000300", "sh000001"]) {
      try {
        indexCacheEstimate +=
          (await stat(join(sourceTdxRoot, "vipdoc/sh/lday", `${symbol}.day`)))
            .size *
            2 +
          16384;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  await sourceDiskBoundary(
    output,
    projectedRankPath,
    rps.rankBytes.byteLength,
    indexCacheEstimate,
  );
  const lowZone = await captureLowZoneSources(
    options,
    files[2]!,
    manifest.inputs.priceHash,
    price.end,
    price.stocks,
    rps.signals,
    frozenAt,
    output,
    configHash,
    projectedRankPath,
    rps.rankBytes.byteLength,
    stage,
  );
  await stage("low-zone:captured");
  const binanceRoot = resolve(options.binanceRoot ?? defaultBinanceRoot),
    cryptoSources: Record<
      string,
      {
        bars: Bar[];
        hash: string;
        files: unknown[];
        missing: string[];
        coverage: ReturnType<typeof lifecycleCryptoCoverage>;
      }
    > = {};
  const cap = "2026-11-13",
    through = dayAfter(cap);
  for (const period of ["day", "4h"] as const)
    for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
      const key = `${symbol}:${period}`,
        interval = period === "day" ? "1d" : "4h";
      try {
        const paths = await publicDataFiles(
          binanceRoot,
          symbol,
          interval,
          0,
          Date.parse(through) - 1,
        );
        if (paths.some((p) => !p.endsWith(".zip")))
          throw new Error(
            "Unchecksummed live CSV is not an original official archive",
          );
        await sourceDiskBoundary(
          output,
          projectedRankPath,
          rps.rankBytes.byteLength,
          paths.length * (period === "day" ? 31 : 186) * 64 + 16384,
        );
        const snapshot = await binanceArchiveSource({
          symbol: `cx${symbol}`,
          period,
          configuredRoot: binanceRoot,
          to: cap,
          now: Date.parse(frozenAt),
        });
        if (!snapshot)
          throw new Error("Native original official archive missing");
        const bars = snapshot.bars.filter((b) =>
          period === "day"
            ? b.date <= cap
            : Date.parse(b.date) <= Date.parse(through),
        );
        const coverage = lifecycleCryptoCoverage(bars, period),
          missing = coverage.missing.map(
            (d) => `native:${key}: incomplete UTC day ${d}`,
          );
        if (snapshot.sourceNote)
          missing.push(`native:${key}: ${snapshot.sourceNote}`);
        if (snapshot.sourceVersions?.length !== paths.length)
          throw new Error("Native file set changed during source freeze");
        const nativeManifests = [];
        // The existing public-data writer owns ONE monthly manifest per
        // symbol/interval; that index also contains daily official ZIPs.
        for (const directory of [
          join(binanceRoot, "data/spot/monthly/klines", symbol, interval),
        ]) {
          const path = join(directory, "manifest.json"),
            bytes = await readFile(path);
          const value = JSON.parse(bytes.toString()) as {
            version: number;
            symbol: string;
            interval: string;
            files: { path: string; sha256: string }[];
          };
          if (
            value.version !== 1 ||
            value.symbol !== symbol ||
            value.interval !== interval ||
            !Array.isArray(value.files)
          )
            throw new Error("Native archive manifest identity mismatch");
          for (let i = 0; i < paths.length; i++)
            if (
              !value.files.some(
                (f) =>
                  resolve(f.path) === resolve(paths[i]!) &&
                  f.sha256 === snapshot.sourceVersions![i],
              )
            )
              throw new Error("Native ZIP differs from its archive manifest");
          nativeManifests.push({ path, hash: bytesHash(bytes) });
        }
        const archiveFiles: unknown[] = [...nativeManifests];
        for (let i = 0; i < paths.length; i++)
          archiveFiles.push({
            path: paths[i]!,
            hash: snapshot.sourceVersions?.[i],
            checksumHash: bytesHash(await readFile(paths[i]! + ".CHECKSUM")),
          });
        cryptoSources[key] = {
          bars,
          hash: snapshot.hash,
          files: archiveFiles,
          coverage,
          missing,
        };
      } catch (error) {
        if (error instanceof LifecycleSourceBudgetError) throw error;
        cryptoSources[key] = {
          bars: [],
          hash: contentHash({ key, unavailable: true }),
          files: [],
          coverage: { complete: [], missing: [], first: null, last: null },
          missing: [
            `native:${key}: ${error instanceof Error ? error.message : "source unavailable"}`,
          ],
        };
      }
    }
  await stage("crypto:captured");
  const cryptoMarket = (period: "day" | "4h"): LifecycleMarketSource => {
    const sources = ["BTCUSDT", "ETHUSDT"].map(
        (s) => cryptoSources[`${s}:${period}`]!,
      ),
      calendar = [
        ...new Set(sources.flatMap((s) => s.bars.map((b) => b.date))),
      ].sort();
    const benchmark = cryptoSources["BTCUSDT:day"]!.bars;
    const identity = {
      root: binanceRoot,
      period,
      symbols: ["BTCUSDT", "ETHUSDT"],
      native: sources.map((s) => ({
        hash: s.hash,
        files: s.files,
        missing: s.missing,
      })),
      benchmarkHash: cryptoSources["BTCUSDT:day"]!.hash,
      costs: marketRules.crypto.costs!,
    };
    return {
      request: {
        market: "crypto",
        initial: 1000000,
        calendar,
        instruments: ["BTCUSDT", "ETHUSDT"].map((symbol, i) => ({
          symbol,
          market: "crypto",
          bars: sources[i]!.bars,
          signalBars: sources[i]!.bars,
          actions: [],
          execution: {
            evidence:
              "Native Binance archive; research quantity grid 0.000001, not historical venue-filter certification",
            minimum: 0.000001,
            step: 0.000001,
            tradable: true,
            limitUp: null,
            limitDown: null,
          },
        })),
        costs: identity.costs,
      },
      benchmark,
      bookFacts: {
        benchmark: { symbol: "BTCUSDT", bars: benchmark },
        roundTripCost:
          (2 * (identity.costs.commissionBps + identity.costs.slippageBps) +
            identity.costs.sellTaxBps) /
          10000,
      },
      inputHash: contentHash(identity),
      source: `Native official Binance ${binanceRoot} ${period}`,
      missing: sources.flatMap((s) => s.missing),
    };
  };
  const markets = {
    "cn-day": cn,
    "crypto-day": cryptoMarket("day"),
    "crypto-4h": cryptoMarket("4h"),
  };
  const families: Record<string, LifecycleFamilyAxis> = {};
  for (const { family } of config.families) {
    const warmup = familyWarmup(config, family);
    if (family === "cn-equity:swing") {
      const { start, end } = config.axes.cnSwing;
      const axisDays = [
        ...new Set([
          start,
          ...cnCalendar.filter((d) => d >= start && d <= end),
          end,
        ]),
      ].sort();
      const missing = [...cnMissing];
      if (!cnCalendar.includes(start) || !cnCalendar.includes(end))
        missing.push(
          "axis: declared CN start/end missing; declared boundaries are preserved",
        );
      if (cnCalendar.indexOf(start) < warmup - 1)
        missing.push(
          "warmup: declared CN axis lacks maximum registered source warmup",
        );
      families[family] = axis(
        axisDays,
        ["cn-day"],
        warmup,
        cnCalendar[0] ?? null,
        missing,
        manifest.firstSignal,
        oracle.finalDate,
      );
    } else if (family === "cn-equity:low-zone") {
      const coverage = lifecycleLowZoneAxis(lowZone.input, warmup);
      families[family] = axis(
        coverage.dailyAxis,
        ["cn-day"],
        warmup,
        coverage.warmupStart,
        [...coverage.missing, ...lowZone.sourceInfo.financial.missing],
        undefined,
        coverage.targetThrough,
      );
    } else {
      const periods = [
        ...new Set(
          config.main
            .filter((m) => m.family === family)
            .map((m) => m.strategy.period),
        ),
      ];
      const keys = [
        ...new Set([
          ...(periods.includes("day") ? ["crypto-day" as const] : []),
          ...(periods.includes("4h") ? ["crypto-4h" as const] : []),
          "crypto-day" as const,
        ]),
      ];
      const needed = [
        ...new Set([
          ...periods.flatMap((p) =>
            ["BTCUSDT", "ETHUSDT"].map((s) => `${s}:${p}`),
          ),
          "BTCUSDT:day",
        ]),
      ].map((key) => ({ key, ...cryptoSources[key]! }));
      const missing = needed.flatMap((s) => s.missing),
        starts = needed.map((s) => s.coverage.first),
        ends = needed.map((s) => s.coverage.last);
      if (starts.some((s) => s === null) || ends.some((s) => s === null)) {
        families[family] = axis([], keys, warmup, null, [
          ...missing,
          "axis: required native source absent; no common axis fabricated",
        ]);
        continue;
      }
      const warmupStart = starts
          .filter((s): s is string => s !== null)
          .sort()
          .at(-1)!,
        start = dayAfter(warmupStart, warmup - 1),
        end = [cap, ...ends.filter((s): s is string => s !== null)].sort()[0]!;
      const dailyAxis = naturalDays(start, end);
      for (const source of needed) {
        const complete = new Set(source.coverage.complete);
        for (const day of naturalDays(warmupStart, end))
          if (!complete.has(day))
            missing.push(
              `axis:${source.key}: ${day} missing; retained in shared axis/warmup`,
            );
      }
      families[family] = axis(dailyAxis, keys, warmup, warmupStart, [
        ...new Set(missing),
      ]);
    }
  }
  await stage("families:axis-frozen");
  const identities = {
    configHash,
    marketIdentities: Object.fromEntries(
      Object.entries(markets).map(([key, source]) => [key, source.inputHash]),
    ),
    classic: cnIdentity,
    lowZone: {
      ...lowZone.sourceInfo,
      indices: lowZone.sourceInfo.indices.map(({ bars, ...source }) => ({
        ...source,
        first: bars[0]?.date,
        last: bars.at(-1)?.date,
        count: bars.length,
      })),
      inputRoles: lowZone.input
        ? {
            index: lowZone.input.index.symbol,
            calendarHash: contentHash(lowZone.input.calendar),
            stocks: lowZone.input.stocks.map((s) => s.symbol),
            valuationRows: lowZone.input.valuations.length,
          }
        : null,
    },
    crypto: {
      root: binanceRoot,
      series: Object.fromEntries(
        Object.entries(cryptoSources).map(([key, s]) => [
          key,
          {
            hash: s.hash,
            files: s.files,
            coverage: s.coverage,
            missing: s.missing,
          },
        ]),
      ),
    },
    families,
  };
  const inputHash = contentHash(identities),
    rankPath = join(output, `ranks-${rps.audit.rankHash}.f32`);
  await stage("source:identity-hashed");
  const manifestOutput = join(output, `source-${inputHash}.json`);
  let originalFrozenAt = frozenAt,
    originalBarStoreBytes: number | undefined;
  try {
    const prior = JSON.parse(await readFile(manifestOutput, "utf8")) as {
      frozenAt: string;
      resources?: { nativeReadColumnCacheBytes?: number };
    };
    if (!Number.isFinite(Date.parse(prior.frozenAt)))
      throw new Error("Frozen source timestamp invalid");
    originalFrozenAt = prior.frozenAt;
    originalBarStoreBytes = prior.resources?.nativeReadColumnCacheBytes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Current-labelled membership is a biased snapshot, not historical
  // availability. Reuse the persisted capture instant for the same identity.
  if (lowZone.input)
    lowZone.input.constituents = lowZone.input.constituents.map((snapshot) => ({
      ...snapshot,
      availableAt: originalFrozenAt,
    }));
  let barStoreBytes = 0;
  try {
    for (const file of await readdir(columnCacheDirectory(), {
      withFileTypes: true,
    }))
      if (file.isFile())
        barStoreBytes += (await stat(join(columnCacheDirectory(), file.name)))
          .size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sourceManifest = {
    version: "lifecycle-source-1",
    frozenAt: originalFrozenAt,
    configHash,
    inputHash,
    identities,
    biasTags: [
      "frozen-CSI800-labelled-roster-effective-date-uncertified",
      "roster-three-in-three-out-versus-later-R2a5-capture",
      "current-industry-lookahead-or-missing",
      "historical-ST-IPO-queue-unverified",
      "current-CSI300-membership-lookahead",
      "low-zone-coverage-must-be-verified",
    ],
    labels: {
      cnDay: "YYYY-MM-DD completed exchange date",
      cryptoDay: "YYYY-MM-DD opening UTC day; completes next00",
      crypto4h: "ISO END label; completion-1ms determines its UTC day",
    },
    rankCache: { path: rankPath, ...rps.audit },
    resources: {
      processes: 1,
      nodeHeapMiB: 4096,
      derivedCacheBytes: rps.rankBytes.byteLength,
      nativeReadColumnCacheBytes: originalBarStoreBytes ?? barStoreBytes,
      derivedCacheLimit: sourceCacheBudget,
      sharedOriginalObjects: true,
      perTrialClone: false,
    },
    boundary:
      "Source freeze/read adapters only. No strategy or equity returns executed. firstSignal is a pre-axis seed; targetThrough and valuationThrough are separate. Missing facts remain explicit.",
  };
  const manifestOutputBytes = JSON.stringify(sourceManifest, null, 2);
  await stage("source:manifest-serialized");
  if (
    rps.rankBytes.byteLength + Buffer.byteLength(manifestOutputBytes) >
    sourceCacheBudget
  )
    throw new Error("Lifecycle derived source cache exceeds512MiB");
  memoryBoundary();
  await mkdir(output, { recursive: true });
  const existing = await readdir(output, { withFileTypes: true });
  let existingBytes = 0;
  for (const file of existing) {
    if (!file.isFile())
      throw new Error("Unexpected non-file in lifecycle derived cache");
    existingBytes += (await stat(join(output, file.name))).size;
  }
  const additional =
    (existing.some((f) => f.name === rankPath.slice(output.length + 1))
      ? 0
      : rps.rankBytes.byteLength) +
    (existing.some((f) => f.name === manifestOutput.slice(output.length + 1))
      ? 0
      : Buffer.byteLength(manifestOutputBytes));
  if (existingBytes + additional + barStoreBytes > sourceCacheBudget)
    throw new Error(
      "Total lifecycle derived source cache exceeds512MiB; preserve existing inputs",
    );
  await immutableFile(rankPath, rps.rankBytes);
  await immutableFile(manifestOutput, manifestOutputBytes);
  await stage("source:complete");
  return {
    version: "lifecycle-source-1",
    configHash,
    frozenAt: originalFrozenAt,
    inputHash,
    source: `Immutable source sidecar ${manifestOutput}`,
    biasTags: sourceManifest.biasTags,
    markets,
    families,
    lowZoneSources: lowZone.sourceInfo,
    ...(lowZone.input ? { lowZoneInput: lowZone.input } : {}),
    manifestPath: manifestOutput,
  };
}
