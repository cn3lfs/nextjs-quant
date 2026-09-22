import { isChanFiveMinute } from "~/lib/research-chan-native";
import { isWyckoffHourly } from "~/lib/research-wyckoff-hourly";
import { readBenchmarkSnapshot } from "../data-sources/tdx/tdx-benchmark";
import { needsCanslimMarket } from "~/lib/research-canslim-market-strategies";
import type { CanslimResearchMarket } from "../strategies/canslim/research-canslim-market-score";
import { resolve } from "node:path";
import { researchJsonHash } from "./research-json";
import type { Bar } from "~/lib/domain";
import type { ResearchSpec } from "~/lib/strategy-research";
import { isRpsMarketSymbol } from "~/lib/rps";
import { settings } from "../infra/settings";
import { readMarketPool } from "../market/market-pool-files";
import { scan, readSnapshot } from "../data-sources/tdx/tdx";
import { assertGrowthIntradayWindow } from "~/lib/research-growth-intraday";
import { isOpening, openingMinuteStart } from "~/lib/research-opening";
import { readLocalDailySnapshot } from "../market/local-daily-snapshot";
import { readGbbq } from "../data-sources/tdx/tdx-gbbq";
import { deriveHistoricalFloatShares } from "../data-sources/tdx/tdx-gbbq";
import {
  buildDailyEventCoverage,
  mergeVolumeEvidence,
} from "~/lib/research-event-coverage";
import { isVolumeAdapted } from "~/lib/research-volume-adapted";
import { isVolumeGrid } from "~/lib/research-volume-grid";
import { isVolumeStrategy } from "~/lib/research-volume";
import { isVolumeContext } from "~/lib/research-volume-context";
import { isVolumeFailure } from "~/lib/research-volume-failure";
import { isVolumeSequence } from "~/lib/research-volume-sequence";
import { isVolumeStructure } from "~/lib/research-volume-structure";
import { isVolumeReversal } from "~/lib/research-volume-reversals";
import {
  researchMethodSnapshot,
  type ResearchMethodSnapshot,
} from "../research/research-method";
// g4day 暂停：import { overlayDailyIncrements } from "./tdx-daily-overlay";

export const researchHash = researchJsonHash;
type CapturedResearchDataset = Awaited<
  ReturnType<typeof captureResearchDataset>
>;
type ResearchStock = CapturedResearchDataset["stocks"][number];
export type ResearchDataset = Omit<
  CapturedResearchDataset,
  "method" | "stocks" | "volumeEvidence"
> & {
  method?: ResearchMethodSnapshot;
  stocks: (Omit<ResearchStock, "volumeEvidence" | "floatShareCoverage"> & {
    volumeEvidence?: ResearchStock["volumeEvidence"];
    floatShareCoverage?: ResearchStock["floatShareCoverage"];
  })[];
  volumeEvidence?: CapturedResearchDataset["volumeEvidence"];
};

export { parseBenchmarkWindow as parseResearchBenchmark } from "../data-sources/tdx/tdx-benchmark";

/**
 * The set of strategies that consume per-day volume evidence. Exported because
 * the batch driver must derive `volumeEvidence` at the point of use with the
 * *preset's* strategy rather than the capture spec's: the capture gate is only
 * correct when the capture spec is the strategy being run, which is false for a
 * driver that captures once with a fixed base spec (manager ruling 2026-09-19,
 * third instance of the same capture-time trap — see .codex-runs/s4-delivery.md).
 */
export function needsVolumeEvidence(strategy: string) {
  return (
    isVolumeStrategy(strategy) ||
    isVolumeGrid(strategy) ||
    isVolumeAdapted(strategy) ||
    isVolumeContext(strategy) ||
    isVolumeFailure(strategy) ||
    isVolumeSequence(strategy) ||
    isVolumeStructure(strategy) ||
    isVolumeReversal(strategy)
  );
}

export async function captureResearchDataset(
  spec: ResearchSpec,
  cancelled: () => boolean = () => false,
  progress: (symbol: string, count: number, total: number) => void = () => {},
) {
  if (
    spec.management?.growthIntraday ||
    isChanFiveMinute(spec.strategy) ||
    isWyckoffHourly(spec.strategy) ||
    spec.strategy === "wy-week-day-hour"
  )
    assertGrowthIntradayWindow(spec.start, spec.end);
  const config = settings(),
    root = resolve(config.tdxRoot);
  const pool = spec.pool
    ? await readMarketPool(config.industryBlocksRoot, spec.pool, config.tdxRoot)
    : null;
  const symbols = [
    ...new Set(
      spec.symbols ??
        pool?.members ??
        (await scan(root)).securities
          .filter((row) => row.period === "day")
          .map((row) => row.symbol),
    ),
  ]
    .filter(isRpsMarketSymbol)
    .sort();
  // g4day 暂停（见 docs/decisions.md WF3）：基准只读本地/完整包缓存快照。
  const benchmarkSource = await readBenchmarkSnapshot(
    root,
    spec.start,
    spec.end,
  );
  const benchmark = benchmarkSource.bars;
  if (!benchmark.some((bar) => bar.date >= spec.start))
    throw new Error("研究区间缺少上证指数基准行情");
  const calendar = benchmark.map((bar) => bar.date);
  const minuteStart = isChanFiveMinute(spec.strategy)
    ? "2000-01-04"
    : isWyckoffHourly(spec.strategy) || spec.strategy === "wy-week-day-hour"
      ? (calendar[
          Math.max(0, calendar.findIndex((d) => d >= spec.start) - 6)
        ] ?? spec.start)
      : spec.management?.growthIntraday &&
          isOpening(spec.management.growthIntraday)
        ? openingMinuteStart(calendar, spec.start)
        : spec.start;
  let canslimMarket: CanslimResearchMarket | undefined;
  if (
    needsCanslimMarket(spec.strategy) ||
    spec.management?.growthDaily === "CA-D-distribution5" ||
    spec.management?.growthDaily === "CA-P-add23"
  ) {
    const snapshot = await readLocalDailySnapshot(root, "sh000300");
    const marketBars = snapshot.bars.filter((bar) => bar.date <= spec.end);
    canslimMarket = {
      symbol: snapshot.symbol,
      source: snapshot.source,
      bars: marketBars,
      hash: researchHash(marketBars),
    };
  }
  let actions: Awaited<ReturnType<typeof readGbbq>> | null = null;
  try {
    actions = await readGbbq(root);
  } catch {
    /* Explicit missing metadata below. */
  }
  const stocks: {
    symbol: string;
    name: string;
    bars: Bar[];
    minuteBars?: Bar[];
    minuteSource?: {
      source: string;
      hash: string;
      start: string | null;
      end: string | null;
    };
    hash: string;
    source?: string;
    sourceVersions?: string[];
    actions: NonNullable<typeof actions>["events"] extends Map<string, infer T>
      ? T
      : never;
    volumeEvidence?: ReturnType<typeof mergeVolumeEvidence>;
    floatShareCoverage?: ReturnType<
      typeof deriveHistoricalFloatShares
    >["coverage"];
  }[] = [];
  const excluded: { symbol: string; reason: string }[] = [];
  let payloadBytes = Buffer.byteLength(JSON.stringify(benchmark));
  for (const [index, symbol] of symbols.entries()) {
    if (cancelled()) throw new Error("研究采集已取消");
    try {
      // g4day 暂停：研究数据集只读本地日线，不叠加通达信增量。
      const snapshot = await readLocalDailySnapshot(root, symbol);
      const bars = snapshot.bars.filter((bar) => bar.date <= spec.end);
      const minute =
        isChanFiveMinute(spec.strategy) ||
        spec.management?.growthIntraday ||
        ((isWyckoffHourly(spec.strategy) ||
          spec.strategy === "wy-week-day-hour") &&
          spec.wyckoffHourlyInputs === undefined)
          ? await readSnapshot(root, symbol, "5m")
          : null;
      const minuteBars = minute?.bars.filter(
        (b) =>
          b.date.slice(0, 10) >= minuteStart && b.date.slice(0, 10) <= spec.end,
      );
      const stockActions = (actions?.events.get(symbol) ?? []).filter(
        (event) => event.date <= spec.end,
      );
      const floatShares = actions
        ? deriveHistoricalFloatShares(bars, stockActions)
        : {
            evidence: {},
            coverage: {
              status: "missing" as const,
              source: "tdx-gbbq" as const,
              coveredBars: 0,
              missingBars: bars.length,
              coveredStart: null,
              coveredEnd: null,
              missingIntervals: bars.length
                ? [
                    {
                      start: bars[0]!.date,
                      end: bars.at(-1)!.date,
                      bars: bars.length,
                      reason: "GBBQ文件不可用",
                    },
                  ]
                : [],
              eventCount: 0,
            },
          };
      const volumeRun = needsVolumeEvidence(spec.strategy);
      // Manager ruling 2026-09-19: the per-day event table (`eventCoverage`) is
      // NOT persisted in the dataset any more. It is a pure function of
      // (symbol, bars, actions, calendar, gbbqAvailable) — computed at the
      // point of use, which is the batch driver building
      // `marketEvidence.rows` (scripts/r3-batch-runner.ts) — because it was
      // 75.8% of a stock's snapshot payload and pushed a full A500 capture past
      // both the 512MiB per-capture cap and V8's single-string limit that
      // `researchHash` needs. `docs/decisions.md:827` registers that cap as a
      // deliberate product limit, so the payload shrank instead of the cap
      // moving. Execution evidence itself is still required for EVERY strategy
      // (research-run.ts gates every fill on marketEvidence.rows), it is just no
      // longer stored here. Only the volume-specific merge below consumes the
      // table here, and only for the volume family; its `volumeEvidence` output
      // is still stored exactly as before.
      const volumeEvidence = volumeRun
        ? mergeVolumeEvidence(
            floatShares.evidence,
            buildDailyEventCoverage(
              symbol,
              bars,
              stockActions,
              calendar,
              actions !== null,
            ),
          )
        : {};
      const raw = {
        symbol,
        name: snapshot.name ?? symbol,
        bars,
        ...(minute
          ? {
              minuteBars,
              minuteSource: {
                source: minute.source,
                hash: minute.hash,
                start: minute.bars[0]?.date ?? null,
                end: minute.bars.at(-1)?.date ?? null,
              },
            }
          : {}),
        source: snapshot.source,
        ...(snapshot.sourceVersions?.length
          ? { sourceVersions: snapshot.sourceVersions }
          : {}),
        actions: stockActions,
        volumeEvidence,
        floatShareCoverage: floatShares.coverage,
      };
      payloadBytes += Buffer.byteLength(JSON.stringify(raw));
      if (payloadBytes > 512 * 1024 * 1024)
        throw new Error("研究行情快照超过512MiB，请缩小证券池");
      stocks.push({ ...raw, hash: researchHash(raw) });
    } catch (error) {
      if (payloadBytes > 512 * 1024 * 1024) throw error;
      excluded.push({
        symbol,
        reason: error instanceof Error ? error.message : "读取行情失败",
      });
    }
    progress(symbol, index + 1, symbols.length);
  }
  const content = {
    version: "research-dataset-1" as const,
    method: researchMethodSnapshot(spec),
    source:
      benchmarkSource.source.startsWith("tdx-full-package") ||
      stocks.some((stock) => stock.source?.startsWith("tdx-full-package"))
        ? ("mixed-tdx-files-full-package" as const)
        : benchmarkSource.sourceVersions?.length ||
            stocks.some((stock) => stock.sourceVersions?.length)
          ? ("tdx-local+g4day" as const)
          : ("tdx-local" as const),
    root,
    adjustment: "none" as const,
    membership: {
      mode: "current-snapshot" as const,
      symbols,
      source: pool,
      warning: "当前成分名单回溯存在生存者偏差，并非历史成分",
    },
    benchmark: {
      symbol: "sh000001",
      bars: benchmark,
      ...(benchmarkSource.sourceVersions?.length
        ? { sourceVersions: benchmarkSource.sourceVersions }
        : {}),
    },
    ...(canslimMarket ? { canslimMarket } : {}),
    calendar,
    stocks,
    excluded,
    actionCoverage: actions ? ("partial" as const) : ("missing" as const),
    actionSource: actions
      ? { path: actions.path, modified: actions.modified }
      : null,
    volumeEvidence: {
      version: "gbbq-float-shares+daily-events-v1" as const,
      source: actions ? "tdx-gbbq" : null,
      coverage: Object.fromEntries(
        stocks.map((stock) => [stock.symbol, stock.floatShareCoverage]),
      ),
    },
  };
  return { ...content, capturedAt: Date.now(), hash: researchHash(content) };
}
