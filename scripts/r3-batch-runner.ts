/**
 * S4 real-backtest campaign driver (moved into version control from the
 * gitignored `.codex-runs/r3-batch-runner.ts` so campaign results are
 * reproducible from a committed file — see docs/executor-brief.md §4
 * "回测只读冻结快照 / 结论必须可复现").
 *
 * Fixes two traps discovered running the R3 driver against the 162 B2/B5
 * composite presets (docs/trading-skills-next-round-plan.md §2 item 3,
 * .codex-runs/s3-delivery.md §1.2):
 *
 * Trap 1: a preset id is not a `strategy` enum value.
 *   `researchSpecSchema.parse({strategy: presetId, ...})` throws
 *   `invalid_enum_value` for every one of the 162 composite presets. The
 *   only correct entry point for those ids is
 *   `buildNamedResearchSpec`/`findResearchCompositePreset`
 *   (src/server/backtest/research-run.ts:154, src/lib/research/specs/research-composite-presets.ts).
 *   Non-composite ids (B3's indicator/pattern names, B4's "wy-" and "chan-"
 *   prefixed strategy names) ARE valid `strategy` enum values and must keep going
 *   through the direct `researchSpecSchema.parse({strategy: id, ...})` path
 *   — `findResearchCompositePreset` returns undefined for them, so `specFor`
 *   below branches correctly either way.
 *
 * Trap 2: 161/162 composite presets resolve to the same `spec.strategy`
 *   ("dual-breakout"; 1 — RK-F-no-single-stop — resolves to
 *   "boll-band-recovery"). Any result key derived from `spec.strategy`
 *   collapses 161 independent trials into one row. This driver has always
 *   kept raw files keyed by the loop's preset-id string (not `spec.strategy`)
 *   — the variable is renamed `presetId` throughout to make that explicit and
 *   prevent an accidental regression to `spec.strategy` in future edits. The
 *   companion trap lived in `scripts/r3-result-table.ts`, which read
 *   `raw.spec?.strategy` as the row key; that is fixed separately in that
 *   file to use the archived filename (the preset id) instead.
 *
 * Third, undocumented-by-name but load-bearing fix: `captureResearchDataset`
 * only fetches 5-minute bars when the *capture-time* spec it is given carries
 * `management.growthIntraday` (or is a chan-five-minute / wyckoff-hourly
 * strategy) — see src/server/backtest/research-dataset.ts:79-85,112-121,174-181. The
 * original driver always captured with a bare `dual-breakout` spec, so any
 * batch containing an intraday-anchored preset (all 29 of B5; 3 of B2 —
 * RK-B-touch/RK-C-swing-system/RK-A-intraday-time; 2 of B4 —
 * WY09/WY10) would have silently gotten `stock.minuteBars === undefined`,
 * producing a false "zero signal" result attributable to a driver bug, not a
 * real data gap. This driver captures two datasets per batch when needed —
 * a cheap daily-only one for the majority of presets, and a minute-inclusive
 * one only for the subset that actually reads intraday bars — and reuses the
 * cheap one whenever a batch has no intraday presets at all (B3; most of B4).
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { deserialize, serialize } from "node:v8";
import {
  researchSpecSchema,
  type ResearchSpec,
} from "../src/lib/research/strategy-research";
import { researchMarketEvidenceSchema } from "../src/lib/research/factors/research-market-evidence";
import {
  captureResearchDataset,
  needsVolumeEvidence,
  researchHash,
  type ResearchDataset,
} from "../src/server/backtest/research-dataset";
import {
  buildDailyEventCoverage,
  mergeVolumeEvidence,
} from "../src/lib/research/factors/research-event-coverage";
import { deriveHistoricalFloatShares } from "../src/server/data-sources/tdx/tdx-gbbq";
import {
  runStrategyResearch,
  buildNamedResearchSpec,
  createResearchCzscCache,
} from "../src/server/backtest/research-run";
import { findResearchCompositePreset } from "../src/lib/research/specs/research-composite-presets";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { readMarketPool } from "../src/server/market/market-pool-files";
import { saveSettings } from "../src/server/infra/settings";
import { settingsSchema } from "../src/lib/domain";
import { analyzeCzsc } from "../src/server/strategies/chan/czsc";
import { isChanC4 } from "../src/lib/research/methods/chan/research-chan-movements";
import {
  isChanNative,
  isChanFiveMinute,
} from "../src/lib/research/methods/chan/research-chan-native";
import { isWyckoffHourly } from "../src/lib/research/methods/wyckoff/research-wyckoff-hourly";
import { writeResearchJsonFile } from "../src/server/backtest/research-json";

// Isolation guard (executor-brief.md §7 / next-round-plan.md §7): this driver
// calls saveSettings(), which writes to the sqlite DB resolved by
// QUANT_DATA_DIR (src/server/db/index.ts:10-14). Refuse to run against the
// default production DB.
if (!process.env.QUANT_DATA_DIR) {
  throw new Error(
    "QUANT_DATA_DIR 未设置：本驱动器会写入 settings 到该目录下的 sqlite。" +
      "先导出隔离目录（例如 QUANT_DATA_DIR=/tmp/quant-s4-<date>）再运行，" +
      "不得对默认生产库写入。",
  );
}

const batch = process.env.R3_BATCH ?? "B3";
const tdxRoot = process.env.R3_TDX_ROOT ?? "E:/new_tdx64";
const archiveRoot = resolve(
  process.env.R3_ARCHIVE ?? `.codex-runs/r3-results/${batch.toLowerCase()}`,
);
const rawRoot = resolve(archiveRoot, "raw");
mkdirSync(rawRoot, { recursive: true });
const map = JSON.parse(
  readFileSync("docs/trading-skills-method-map.json", "utf8"),
) as {
  methods: Array<{
    id: string;
    batch: string;
    title: string;
    bindings?: { presets?: string[] };
  }>;
};
const excludedB3 = new Set([
  "VP14",
  "VP-wash-intraday",
  "VP-wash-chips",
  "VP-wash-news",
  "VP-wash-composite",
]);
const targetBatches: Record<string, string[]> = {
  B2: ["K2a", "K7"],
  B3: ["K2b"],
  B4: ["K5", "K6"],
  B5: ["K8"],
};
const targetMethods = map.methods.filter(
  (method) =>
    targetBatches[batch]?.includes(method.batch) &&
    !(batch === "B3" && excludedB3.has(method.id)),
);
if (!targetMethods.length) throw new Error(`没有找到批次 ${batch} 的方法`);

const poolSelection = {
  category: "index" as const,
  name: "通达信·成分·中证A500",
};
const pool = await readMarketPool("", poolSelection, tdxRoot, true);
const requestedSymbols = process.env.R3_SYMBOLS?.split(",").filter(Boolean);
const limit = Number(process.env.R3_SYMBOL_LIMIT ?? pool.members.length);
const symbols = (
  requestedSymbols?.length ? requestedSymbols : pool.members
).slice(0, limit);
const start = "2000-01-04";
const end = "2022-11-30";
const validationStart = "2017-01-03";
const holdingDays = 5;
// entryMaxWait sensitivity grid (next-round-plan.md §5): default stays 3;
// R3_ENTRY_MAX_WAIT lets a run register a different grid point under a
// separate R3_ARCHIVE path without touching the default.
const entryMaxWait = Number(process.env.R3_ENTRY_MAX_WAIT ?? 3);
// Parallel shards otherwise stamp market evidence with their own Date.now(),
// which makes the evidence hash (and therefore the raw result hash) differ
// even when the actual evidence rows are identical.  A manager may inject one
// run-wide epoch-millisecond value into every shard; omitting it preserves the
// historical behavior for standalone runs.
const marketEvidenceExportedAt = (() => {
  const raw = process.env.R3_MARKET_EVIDENCE_EXPORTED_AT;
  if (raw === undefined || raw.trim() === "") return Date.now();
  const normalized = raw.trim();
  if (!/^[1-9]\d*$/.test(normalized))
    throw new Error(
      "R3_MARKET_EVIDENCE_EXPORTED_AT 需为十进制正整数 epoch 毫秒",
    );
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(
      "R3_MARKET_EVIDENCE_EXPORTED_AT 需为正的安全整数 epoch 毫秒",
    );
  return value;
})();
const initialCapital = 1_000_000;
const maxPositions = 5;
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 3,
  minimumCommission: 5,
  sellTaxBps: 5,
  slippageBps: 5,
};
const preRegisteredSensitivity = {
  holdingDays: [5, 10, 20],
  entryMaxWait: [3, 5, 10],
  stopFraction: [0.03, 0.05, 0.08],
  riskFraction: [0.005, 0.01, 0.02],
  rule: "primary parameters are frozen first; each listed factor is run alone (separate R3_ARCHIVE path), then only the named primary-combination rows; no result is used to tune another row; this run's own entryMaxWait is recorded below, not assumed.",
};

const baseSpec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  symbols,
  pool: poolSelection,
  start,
  end,
  validationStart,
  holdingDays,
  entryMaxWait,
  initialCapital,
  maxPositions,
  costs,
});
saveSettings(settingsSchema.parse({ tdxRoot, industryBlocksRoot: "" }));

/** The only correct id -> spec resolution (see file header, Trap 1). */
function specFor(id: string): ResearchSpec {
  if (findResearchCompositePreset(id))
    return buildNamedResearchSpec(id, baseSpec);
  return researchSpecSchema.parse({
    strategy: id,
    symbols,
    pool: poolSelection,
    start,
    end,
    validationStart,
    holdingDays,
    entryMaxWait,
    initialCapital,
    maxPositions,
    costs,
  });
}

const uniquePresets = [
  ...new Set(targetMethods.flatMap((method) => method.bindings?.presets ?? [])),
].sort();

// Scope filter — PURPOSE-LIMITED: this exists ONLY for the single-factor
// entryMaxWait sensitivity grid (next-round-plan.md §5), where re-running a
// preset that cannot respond to the factor is provably information-free. It is
// NOT a general "shrink the batch" switch and must not become the normal path:
// a batch run without R3_ONLY_PRESETS covers every preset the method map asks
// for (the default is full scope, and omitting the variable is how every
// registered batch result was produced).
//
// `R3_ONLY_PRESETS` is a comma/space list or `@path` to a file with one id per
// line. Excluding a preset is only sound when the factor provably cannot change
// its result: for `entryMaxWait` that means presets with zero events, because
// the factor only acts on *unfilled buy intents*
// (src/server/backtest/research-portfolio.ts:967 expiry, :980 reversal cancel) and a
// preset with no events never creates one. The caller registers the exclusion,
// its reason, and which presets were left out; this flag only implements scope.
const onlyEnv = (process.env.R3_ONLY_PRESETS ?? "").trim();
const onlyList = onlyEnv
  ? (onlyEnv.startsWith("@") ? readFileSync(onlyEnv.slice(1), "utf8") : onlyEnv)
      .split(/[\s,]+/)
      .filter(Boolean)
  : [];
const unknownOnly = onlyList.filter((id) => !uniquePresets.includes(id));
if (unknownOnly.length)
  throw new Error(
    `R3_ONLY_PRESETS 含不属于本批的预设：${unknownOnly.join(",")}`,
  );
const scopedPresets = onlyList.length
  ? uniquePresets.filter((id) => onlyList.includes(id))
  : uniquePresets;

const resolvedSpecs = new Map<string, ResearchSpec>(
  uniquePresets.map((id) => [id, specFor(id)]),
);

function needsMinute(spec: ResearchSpec) {
  return (
    !!spec.management?.growthIntraday ||
    isChanFiveMinute(spec.strategy) ||
    isWyckoffHourly(spec.strategy) ||
    spec.strategy === "wy-week-day-hour"
  );
}

const minutePresets = scopedPresets.filter((id) =>
  needsMinute(resolvedSpecs.get(id)!),
);
const dailyPresets = scopedPresets.filter(
  (id) => !needsMinute(resolvedSpecs.get(id)!),
);

// Sharding (manager request, 2026-09-19): presets have independent specs and
// result files, so a batch may be split across N OS processes with
// R3_SHARD=i/N. Each shard runs a disjoint slice (`index % N === i`) of the
// same sorted preset list and writes the same raw/<presetId>.json files it
// would have written serially, so a single preset's result is byte-identical
// whether it runs alone or inside a shard. The optional R3_REUSE_CZSC path
// shares only exact, hash-keyed non-C4 CZSC prefix promises within one process;
// it is disabled by default and does not change the result contract. What is NOT sharded-safe on its own
// is the batch-level bookkeeping: every shard would otherwise overwrite
// records.json/summary.json with only its own slice, so a shard writes
// records.shard-<i>-of-<N>.json / summary.shard-<i>-of-<N>.json instead, and
// the final canonical pair is produced by one unsharded assembly run after all
// shards finish (raw files are reused, no preset is recomputed).
const shard = (process.env.R3_SHARD ?? "").split("/");
const shardCount = shard.length === 2 ? Number(shard[1]) : 1;
const shardIndex = shard.length === 2 ? Number(shard[0]) : 0;
if (
  !Number.isInteger(shardCount) ||
  !Number.isInteger(shardIndex) ||
  shardCount < 1 ||
  shardIndex < 0 ||
  shardIndex >= shardCount
)
  throw new Error("R3_SHARD 需为 i/N（0 <= i < N）");
const ownedPresets = scopedPresets.filter(
  (_id, index) => index % shardCount === shardIndex,
);
const shardSuffix =
  shardCount > 1 ? `.shard-${shardIndex}-of-${shardCount}` : "";
// Capture-only mode: build the dataset caches without running presets, so N
// shards can then start concurrently against a warm cache instead of racing to
// capture the same file.
const captureOnly = process.env.R3_CAPTURE_ONLY === "1";
console.log(
  `shard ${shardIndex}/${shardCount} presets ${ownedPresets.length}/${scopedPresets.length}` +
    (scopedPresets.length === uniquePresets.length
      ? ""
      : ` (scoped from ${uniquePresets.length} by R3_ONLY_PRESETS)`) +
    (captureOnly ? " (capture-only)" : ""),
);

async function loadOrCapture(
  cachePath: string,
  captureSpecFor: ResearchSpec,
  label: string,
): Promise<ResearchDataset> {
  if (existsSync(cachePath) && process.env.R3_REFRESH_DATASET !== "1") {
    const loaded = deserialize(readFileSync(cachePath)) as ResearchDataset;
    console.log(
      `loaded ${label} dataset ${loaded.hash} stocks=${loaded.stocks.length}`,
    );
    return loaded;
  }
  const captured = await captureResearchDataset(
    captureSpecFor,
    () => false,
    (symbol, done, total) => {
      if (done === total || done % 25 === 0)
        console.log(`capture ${label} ${done}/${total} ${symbol}`);
    },
  );
  writeFileSync(cachePath, serialize(captured));
  console.log(
    `saved ${label} dataset ${captured.hash} stocks=${captured.stocks.length}`,
  );
  return captured;
}

let dailyDataset: ResearchDataset | null = null;
let minuteDataset: ResearchDataset | null = null;

if (dailyPresets.length) {
  const cachePath = resolve(
    process.env.R3_DATASET_CACHE ?? resolve(archiveRoot, "dataset-daily.bin"),
  );
  dailyDataset = await loadOrCapture(cachePath, baseSpec, "daily");
}
if (minutePresets.length) {
  const cachePath = resolve(
    process.env.R3_MINUTE_DATASET_CACHE ??
      resolve(archiveRoot, "dataset-minute.bin"),
  );
  // Any resolved spec that actually trips needsMinute() makes
  // captureResearchDataset fetch 5-minute bars for the whole pool (the
  // per-symbol minute-fetch condition only reads spec.management/
  // spec.strategy, both batch-level constants here — see file header).
  const captureTrigger = resolvedSpecs.get(minutePresets[0]!)!;
  minuteDataset = await loadOrCapture(cachePath, captureTrigger, "minute");
}
const evidenceDataset = (dailyDataset ?? minuteDataset)!;
const datasetFor = (id: string) =>
  needsMinute(resolvedSpecs.get(id)!) ? minuteDataset! : dailyDataset!;
if (captureOnly) {
  console.log(
    JSON.stringify(
      {
        captureOnly: true,
        dailyStocks: dailyDataset?.stocks.length ?? 0,
        minuteStocks: minuteDataset?.stocks.length ?? 0,
        dailyDatasetHash: dailyDataset?.hash ?? null,
        minuteDatasetHash: minuteDataset?.hash ?? null,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

// Manager ruling 2026-09-19: the per-day event table is no longer persisted in
// the dataset (it was 75.8% of a stock's snapshot payload, which pushed a full
// A500 capture past the 512MiB cap that docs/decisions.md:827 registers as a
// deliberate product limit). It is a pure function of
// (symbol, bars, actions, calendar, gbbqAvailable), so it is derived here, at
// the single point of use. The 5th argument mirrors capture's `actions !== null`
// (src/server/backtest/research-dataset.ts), i.e. `actionCoverage !== "missing"`.
const gbbqAvailable = evidenceDataset.actionCoverage !== "missing";
const eventCoverageBySymbol = new Map(
  evidenceDataset.stocks.map((stock) => [
    stock.symbol,
    buildDailyEventCoverage(
      stock.symbol,
      stock.bars,
      stock.actions,
      evidenceDataset.calendar,
      gbbqAvailable,
    ),
  ]),
);
const evidenceRows = evidenceDataset.stocks.flatMap((stock) =>
  (eventCoverageBySymbol.get(stock.symbol)?.rows ?? [])
    .filter((row) => row.hasBar && row.priceLimit.status === "derived")
    .map((row) => ({
      symbol: stock.symbol,
      date: row.date,
      tradable: row.suspension.state !== "suspended",
      limitUp: row.priceLimit.up,
      limitDown: row.priceLimit.down,
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 1_000_000,
      minimumSell: 100,
      sellStep: 100,
      sellOddLotAll: true,
      maximumSell: 1_000_000,
      evidenceId: `derived:${stock.symbol}:${row.date}`,
    })),
);
// Fail-fast guard against the "silent all-zero battle" failure mode, which
// this project has now hit twice, both times producing a full batch of
// zero-trade rows that looked like a legitimate negative result:
//   1. `research-dataset.ts`'s former `needsVolumeEvidence` gate left the
//      per-day event rows empty for every non-volume strategy.
//   2. A dataset cache captured *before* that fix kept being reused, so a
//      corrected source tree still yielded zero evidence.
// Zero evidence rows means no attempted buy can ever be filled, so every
// strategy would report zero trades for a reason that has nothing to do with
// the strategy. Refuse to run rather than emit that table.
if (evidenceRows.length === 0) {
  const coverageRows = [...eventCoverageBySymbol.values()].reduce(
    (sum, coverage) => sum + coverage.rows.length,
    0,
  );
  throw new Error(
    "逐日执行证据为 0 行：任何买入都无法成交，本次战役只会产出全零结果，已中止。" +
      `已抓取 ${evidenceDataset.stocks.length} 只证券，现算的逐日事件行合计 ${coverageRows} 行。` +
      "常见原因有二：(1) 数据集里没有任何可用证券（池/覆盖判定全数拒绝）；" +
      "(2) buildDailyEventCoverage 的输入（bars/actions/calendar/gbbqAvailable）为空。" +
      "排查时请核对 summary.json 的 data.evidenceRows 字段。",
  );
}
const corporateActionFree = evidenceDataset.stocks
  .filter(
    (stock) =>
      !stock.actions.some(
        (action) =>
          action.category === 1 && action.date >= start && action.date <= end,
      ),
  )
  .map((stock) => ({
    symbol: stock.symbol,
    start,
    end,
    evidenceId: `gbbq:no-category-1:${stock.symbol}`,
  }));
const marketEvidence = researchMarketEvidenceSchema.parse({
  version: "research-market-evidence-1",
  source: "tdx-gbbq+daily-event-coverage-r3-real-v1",
  exportedAt: marketEvidenceExportedAt,
  adjustment: "none",
  corporateActionFree,
  rows: evidenceRows,
});

function summarizeResult(result: any) {
  if (result?.status === "failed") return result;
  return {
    status: "complete" as const,
    hash: result.hash ?? null,
    eventCount:
      result.events?.filter((event: any) => event.side !== "exit").length ?? 0,
    outcomeCount:
      result.outcomes?.filter((outcome: any) => outcome.grossReturn !== null)
        .length ?? 0,
    partitions: result.partitions?.map((partition: any) => ({
      partition: partition.partition,
      events: partition.events,
      pending: partition.pending,
      unavailable: partition.unavailable,
      signalStatistics: partition.eventStatistics,
      trades: partition.simulation?.trades.length ?? null,
      simulationStatistics: partition.simulation?.statistics ?? null,
    })),
  };
}

const strategyResults = new Map<string, any>();
const reuseCzsc = process.env.R3_REUSE_CZSC === "1";
const czscCache = createResearchCzscCache();
for (const [index, presetId] of ownedPresets.entries()) {
  // Archive key is always the preset id, never `spec.strategy` (Trap 2).
  const rawPath = resolve(rawRoot, `${presetId}.json`);
  if (existsSync(rawPath) && process.env.R3_REFRESH_RESULTS !== "1") {
    strategyResults.set(
      presetId,
      summarizeResult(JSON.parse(readFileSync(rawPath, "utf8"))),
    );
    console.log(
      `reuse ${index + 1}/${ownedPresets.length} ${presetId} (shard ${shardIndex}/${shardCount})`,
    );
    continue;
  }
  console.log(
    `run ${index + 1}/${ownedPresets.length} ${presetId} (shard ${shardIndex}/${shardCount})`,
  );
  try {
    const strategySpec = resolvedSpecs.get(presetId)!;
    const dataset = datasetFor(presetId);
    const { hash: _baseHash, ...datasetContent } = dataset;
    // Third capture-time trap (manager 2026-09-19): `volumeEvidence` was
    // gated at *capture* time by `needsVolumeEvidence(captureSpec.strategy)`,
    // and this driver captures once with a fixed `dual-breakout` base spec — so
    // every stock carried `{}` and the volume family silently lost its
    // evidence-layer pollution filtering (turnover always null, and the
    // corporate-action / suspension / resumption anomaly flags null without
    // any consumer for the computed-but-ignored `unverified` list). Derive it
    // here with the *preset's* strategy, exactly like the per-day event table,
    // and only for the presets that actually consume it, so every other
    // preset's dataset hash is unchanged.
    const stocks = needsVolumeEvidence(strategySpec.strategy)
      ? datasetContent.stocks.map((stock) => ({
          ...stock,
          volumeEvidence: mergeVolumeEvidence(
            deriveHistoricalFloatShares(stock.bars, stock.actions).evidence,
            eventCoverageBySymbol.get(stock.symbol)!,
          ),
        }))
      : datasetContent.stocks;
    const strategyDataset = {
      ...datasetContent,
      stocks,
      method: researchMethodSnapshot(strategySpec),
      hash: researchHash({
        ...datasetContent,
        stocks,
        method: researchMethodSnapshot(strategySpec),
      }),
    };
    const result = await runStrategyResearch(
      strategySpec,
      strategyDataset,
      marketEvidence,
      (bars, anchor) =>
        analyzeCzsc(
          bars,
          true,
          undefined,
          true,
          anchor,
          isChanC4(strategySpec.strategy),
        ),
      undefined,
      undefined,
      reuseCzsc && !isChanC4(strategySpec.strategy)
        ? {
            czscCache,
            czscCacheNamespace: "r3-analyze-v1/non-c4",
          }
        : undefined,
    );
    writeResearchJsonFile(rawPath, result);
    strategyResults.set(presetId, summarizeResult(result));
  } catch (error) {
    const failure = {
      status: "failed" as const,
      error: error instanceof Error ? error.message : String(error),
    };
    writeFileSync(rawPath, JSON.stringify(failure, null, 2));
    strategyResults.set(presetId, failure);
  }
}

function labelFor(result: any) {
  if (result?.status === "failed") {
    const message = String(result.error);
    return message.toLowerCase().includes("missing") || message.includes("缺")
      ? "数据不足"
      : "规则实现失败";
  }
  if (!result.eventCount) return "无交易";
  if (!result.outcomeCount) return "数据不足";
  if (result.outcomeCount < 30) return "样本不足";
  const development = result.partitions?.find(
    (row: any) => row.partition === "development",
  );
  const validation = result.partitions?.find(
    (row: any) => row.partition === "validation",
  );
  const de = development?.eventStatistics?.expectancy;
  const ve = validation?.eventStatistics?.expectancy;
  if (Number.isFinite(de) && Number.isFinite(ve) && de * ve < 0)
    return "不稳定";
  if (Number.isFinite(ve)) return ve > 0 ? "当前样本表现较好" : "表现较差";
  return "样本不足";
}

type RecordRow = {
  recordId: string;
  methodId: string;
  presetId: string | null;
  resolvedStrategy: string | null;
  anchor: "five-minute" | "daily-or-monthly" | null;
  chanUnverifiedBaseline: boolean;
  label: string;
  status: "failed" | "complete";
  resultHash: string | null;
  rawPath: string | null;
  partitions: unknown;
  error: string | undefined;
  reason?: string;
};

const records: RecordRow[] = targetMethods.flatMap((method): RecordRow[] => {
  const presets = method.bindings?.presets ?? [];
  if (!presets.length) {
    // No preset means no raw file, so no shard can read a result for it; only
    // shard 0 emits the placeholder so the assembled records list holds it
    // exactly once.
    return shardIndex === 0
      ? [
          {
            recordId: `r3-${batch.toLowerCase()}-${method.id}-no-executable-entry`,
            methodId: method.id,
            presetId: null,
            resolvedStrategy: null,
            anchor: null,
            chanUnverifiedBaseline: false,
            label: "规则实现失败",
            status: "failed",
            resultHash: null,
            rawPath: null,
            partitions: null,
            error: undefined,
            reason:
              "方法登记只有导出函数/组件，没有可由共享真实研究引擎调用的具名策略入口；未将固定输入测试替代为历史结果。",
          },
        ]
      : [];
  }
  return presets
    .filter((presetId) => strategyResults.has(presetId))
    .map((presetId): RecordRow => {
      const result = strategyResults.get(presetId);
      const label = labelFor(result);
      const recordId = `r3-${batch.toLowerCase()}-${method.id}-${presetId}`;
      const resolvedSpec = resolvedSpecs.get(presetId);
      return {
        recordId,
        methodId: method.id,
        presetId,
        resolvedStrategy: resolvedSpec?.strategy ?? null,
        anchor: needsMinute(resolvedSpec ?? baseSpec)
          ? ("five-minute" as const)
          : ("daily-or-monthly" as const),
        chanUnverifiedBaseline:
          !!resolvedSpec &&
          (isChanNative(resolvedSpec.strategy) ||
            isChanC4(resolvedSpec.strategy)),
        label,
        status: result?.status === "failed" ? "failed" : "complete",
        resultHash: result?.hash ?? null,
        rawPath: `raw/${presetId}.json`,
        partitions: result?.status === "failed" ? null : result.partitions,
        error: result?.status === "failed" ? result.error : undefined,
      };
    });
});
const summary = {
  version: "r3-real-batch-2" as const,
  batch,
  generatedAt: new Date().toISOString().slice(0, 10),
  status: "completed",
  targetMethodCount: targetMethods.length,
  targetMethodIds: targetMethods.map((method) => method.id),
  pool: {
    selection: poolSelection,
    hash: pool.hash,
    sourceRoot: tdxRoot,
    currentMembership: true,
    members: pool.members.length,
    selected: symbols.length,
    selectedHash: symbols.join(","),
  },
  window: {
    daily: { start, end, validationStart },
    holdingDays,
    entryMaxWait,
    fiveMinuteAnchor: {
      start,
      end,
      separateTable: true,
      presetCount: minutePresets.length,
      note: "五分钟锚窗口与日线/月线锚窗口数值恰好一致（同为 2000-01-04..2022-11-30）不代表两者可比；两者统计口径不同（bar 粒度、逐日可用性不同），必须分表，不得在同一张表里比较。",
    },
  },
  biasNotes: {
    membership:
      "证券池为通达信·成分·中证A500的当前成分快照（非时点历史成分）。方向不保守：隐含“后来还活着且还在池里”，即已经历幸存者筛选，历史当时被剔除/退市/未纳入的证券不在样本中。S5（时点成分）完成前，本表任何结果均带此偏差，且此偏差通常使结果好看于历史真实可交易情形。",
    corporateActionCoverage:
      "dataset.actionCoverage 永远不会是 full（research-dataset.ts 只发 partial 或 missing）；本地 GBBQ 覆盖判定是较强证据而非证明——“在一个我们拒绝称之为完整的源里没查到记录”不等于“没发生过”。",
    chanBaseline:
      "依赖 czsc 输出的方法（chan-native / chan-c4 系列）建立在未经验证的基线上：czsc-tdx 自带 tests 断言本身有误，不得据其判断实现正确性。本表逐行标注 chanUnverifiedBaseline。",
  },
  costs,
  cash: { initialCapital, maxPositions, cashBaselineReturn: 0 },
  data: {
    dailyDatasetHash: dailyDataset?.hash ?? null,
    minuteDatasetHash: minuteDataset?.hash ?? null,
    dailyStocks: dailyDataset?.stocks.length ?? 0,
    minuteStocks: minuteDataset?.stocks.length ?? 0,
    excluded: evidenceDataset.excluded.length,
    actionCoverage: evidenceDataset.actionCoverage,
    evidenceRows: evidenceRows.length,
    corporateActionFree: corporateActionFree.length,
    transactionSimulation: corporateActionFree.length
      ? "computed only for covered symbols"
      : "not available: no selected symbol has a full no-category-1 company-action span",
    historicalFloatShares:
      "missing intervals remain missing; no current-share backfill",
  },
  baselines: {
    cash: { return: 0, trades: 0 },
    buyHold: {
      status:
        corporateActionFree.length === symbols.length ? "computed" : "data不足",
      note:
        corporateActionFree.length === symbols.length
          ? "same window, same costs and 100-share rules"
          : `same-cost portfolio buy-and-hold was not promoted: company-action-free proof covers ${corporateActionFree.length}/${symbols.length} selected symbols; no partial subset was used as the pool baseline`,
    },
  },
  preRegisteredSensitivity,
  records,
  labels: Object.fromEntries(
    Object.entries(
      records.reduce<Record<string, number>>((counts, record) => {
        counts[record.label] = (counts[record.label] ?? 0) + 1;
        return counts;
      }, {}),
    ),
  ),
};
writeFileSync(
  resolve(archiveRoot, `records${shardSuffix}.json`),
  JSON.stringify(records, null, 2),
);
writeFileSync(
  resolve(archiveRoot, `summary${shardSuffix}.json`),
  JSON.stringify(summary, null, 2),
);
console.log(
  JSON.stringify(
    {
      batch,
      shard: `${shardIndex}/${shardCount}`,
      entryMaxWait,
      methods: targetMethods.length,
      presets: uniquePresets.length,
      scopedPresets: scopedPresets.length,
      onlyPresets: onlyList.length ? onlyList.length : null,
      ownedPresets: ownedPresets.length,
      dailyPresets: dailyPresets.length,
      minutePresets: minutePresets.length,
      records: records.length,
      labels: summary.labels,
      dailyDatasetHash: dailyDataset?.hash ?? null,
      minuteDatasetHash: minuteDataset?.hash ?? null,
      corporateActionFree: corporateActionFree.length,
      wrote: `records${shardSuffix}.json summary${shardSuffix}.json`,
    },
    null,
    2,
  ),
);
