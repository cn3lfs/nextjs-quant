import { isChanC4 } from "~/lib/research-chan-movements";
import { isOpening } from "~/lib/research-opening";
import { isMarketAdmission } from "~/lib/research-market-admission";
import { isIntradayExecution } from "~/lib/research-intraday-execution";
import { researchChanMonthlyInput } from "../strategies/chan/research-chan-monthly";
import { researchK13Report, type K13ReportInput } from "~/lib/research-k13";

export function runK13Review(input: K13ReportInput) {
  return researchK13Report(input);
}

export async function runChanMonthlyInput(
  ...args: Parameters<typeof researchChanMonthlyInput>
) {
  return researchChanMonthlyInput(...args);
}
import { chanSectorAdmission } from "~/lib/research-chan-sector";
/** CH11 engineering comparison uses current-membership-v1 and exposes its bias. */
export function runChanSectorResearch(
  raw: unknown,
  asOf: string,
  symbol: string,
  nativeThirdBuy: boolean,
) {
  return chanSectorAdmission(
    raw,
    asOf,
    symbol,
    nativeThirdBuy,
    "current-membership-v1",
  );
}
import { researchManagementSchema } from "~/lib/research-management";
import { evaluateCryptoTimeSlot } from "~/lib/research-crypto-time-slot";

export function runCryptoTimeSlotResearch(raw: unknown) {
  return evaluateCryptoTimeSlot(raw);
}
import { evaluateGrowthFactors } from "../strategies/canslim/research-growth-factors";
import type { CanslimAsOfRequest } from "../strategies/canslim/canslim-as-of-dossier";

/** B6b waiting-data research: scores and evidence only, never simulated trades. */
export function runGrowthFactorResearch(
  request: CanslimAsOfRequest,
  observations: unknown,
  methods?: readonly string[],
) {
  return evaluateGrowthFactors(request, observations, methods);
}
import { wyckoffHourlyFromMinutes } from "../strategies/wyckoff/research-wyckoff-hourly";
import { isWyckoffHourly } from "~/lib/research-wyckoff-hourly";
import { isChanNative } from "~/lib/research-chan-native";
import type { ResearchStructureObservation } from "~/lib/research-structure-events";
import { isWyckoffVsa } from "~/lib/research-wyckoff-vsa";
import { isWyckoff } from "~/lib/research-wyckoff";
import { replayRiskRepair } from "~/lib/research-risk-repair";
import { diagnoseStops } from "~/lib/research-risk-routing";
import { evaluateRiskExtension } from "~/lib/research-risk-extensions";
import {
  researchMaeTraining,
  type ResearchMaeTraining,
} from "~/lib/research-stop-calibration";
import { contextRiskPoint } from "~/lib/research-context-risk";
import {
  externalVolatilityPoint,
  isExternalVolatility,
} from "~/lib/research-volatility-input";
import { riskPresetAdmission } from "~/lib/research-risk-presets";
import { riskAdmissionNeedsTraining } from "~/lib/research-risk-admission";
import { isVolumePollution } from "~/lib/research-volume-pollution";
import { isVolumeAdapted } from "~/lib/research-volume-adapted";
import { isIndicatorCombination } from "~/lib/research-indicator-combinations";
import { isSwingCore } from "~/lib/research-swing-core";
import { isSwingMarket } from "~/lib/research-swing-market";
import { isVolumeIntraday } from "~/lib/research-volume-intraday";
import { isExternalFormula } from "~/lib/research-formula-external";
import { isFormulaExample } from "~/lib/research-formula-examples";
import { isPatternCombination } from "~/lib/research-pattern-combinations";
import { isTechnicalMethod } from "~/lib/research-technical-methods";
import {
  assertGrowthIntradayWindow,
  growthIntradayDescription,
} from "~/lib/research-growth-intraday";
import {
  growthIntradayEntries,
  researchGrowthIntraday,
} from "../strategies/canslim/research-growth-intraday";
import { isSepaResearch } from "~/lib/research-sepa-strategies";
import { isCanslimMarket } from "~/lib/research-canslim-market-strategies";
import { isCanslimMarketCombination } from "~/lib/research-canslim-market-strategies";
import { researchCanslimMarketWarnings } from "../strategies/canslim/research-canslim-market-combination";
import {
  isCanslimResearch,
  isCanslimHigh,
  canslimHighWarmupStart,
  canslimShapeWarmup,
  isCanslimCup,
  isCanslimPriority,
} from "~/lib/research-canslim-strategies";
import { researchKellyNetPayoff } from "~/lib/research-kelly-payoff";
import {
  researchKellyTraining,
  type ResearchKellyTraining,
} from "~/lib/research-kelly-training";
import type { Bar } from "~/lib/domain";
import type { CzscResult } from "~/lib/czsc";
import {
  researchTradeStatistics,
  type ResearchEvent,
  type ResearchSpec,
} from "~/lib/strategy-research";
import {
  researchEvidenceLookup,
  type ResearchMarketEvidence,
} from "~/lib/research-market-evidence";
import { researchSignals } from "../strategies/shared/research-signals";
import { researchOutcomes } from "./research-outcomes";
import { researchPortfolio } from "./research-portfolio";
import { researchHash, type ResearchDataset } from "./research-dataset";
import { prepareResearchAdjustedCoverage } from "./research-adjustment-coverage";
import { validateResearchMethod } from "../research/research-method";
import { isVolumeStrategy, volumeWarmupStart } from "~/lib/research-volume";
import { isVolumeContext } from "~/lib/research-volume-context";
import { isContinuation } from "~/lib/research-continuation";
import { isBreakoutRule } from "~/lib/research-breakout-rules";
import {
  isChannelStrategy,
  channelWarmupStart,
  channelWarmupBars,
} from "~/lib/research-channels";
import { isCandleStrategy, candleWarmupStart } from "~/lib/research-candles";
import { isVolumeSequence } from "~/lib/research-volume-sequence";
import { isVolumeFailure } from "~/lib/research-volume-failure";
import {
  isVolumeStructure,
  volumeStructureWarmupStart,
} from "~/lib/research-volume-structure";
import {
  isVolumeReversal,
  volumeReversalWarmupStart,
} from "~/lib/research-volume-reversals";
import {
  buildResearchCompositeSpec,
  researchCompositePresetIds,
} from "~/lib/research-composite-presets";

export type ResearchCzscCache = Map<string, Promise<CzscResult>>;

const defaultResearchCzscCacheEntries = 256;

class BoundedResearchCzscCache extends Map<string, Promise<CzscResult>> {
  private readonly limit: number;

  constructor(limit: number) {
    super();
    this.limit =
      Number.isInteger(limit) && limit > 0
        ? limit
        : defaultResearchCzscCacheEntries;
  }

  override get(key: string) {
    const value = super.get(key);
    if (value) {
      super.delete(key);
      super.set(key, value);
    }
    return value;
  }

  override set(key: string, value: Promise<CzscResult>) {
    super.delete(key);
    super.set(key, value);
    while (this.size > this.limit) {
      const oldest = super.keys().next().value;
      if (oldest === undefined) break;
      super.delete(oldest);
    }
    return this;
  }
}

/**
 * Create the bounded cache used by long-running batch executors. A full CZSC
 * prefix contains diagnostics and native projection arrays; retaining every
 * prefix across a 280-symbol campaign is an avoidable process-wide memory
 * sink. Eviction only removes a reuse opportunity: a later miss recomputes
 * the exact same prefix and cannot change the research result.
 */
export function createResearchCzscCache(
  limit = defaultResearchCzscCacheEntries,
): ResearchCzscCache {
  return new BoundedResearchCzscCache(limit);
}

export interface ResearchRunOptions {
  /** Executor-scoped cache for identical CZSC prefix requests. */
  czscCache?: ResearchCzscCache;
  czscCacheNamespace?: string;
}

/** Resolve a declared component×baseline preset before entering the shared engine.
 * This is the only correct entry point for turning a preset id into a
 * runnable spec: `researchSpecSchema.parse({ strategy: id, ... })` throws
 * (preset ids are not in the `strategy` enum — they expand onto a shared
 * baseline strategy via `management`/`risk` overrides instead). See the
 * `researchSpecSchema.safeParse({strategy: id})` regression guard in
 * tests/research-composite-presets.test.ts. */
export function buildNamedResearchSpec(id: string, base: ResearchSpec) {
  return buildResearchCompositeSpec(id, base);
}

/**
 * Enumerates every registered composite preset as an `{id, spec}` pair.
 * All 162 presets currently resolve to the same `spec.strategy` (the
 * shared baseline they expand onto), so any caller that keys results by
 * `spec.strategy` collapses them into one row. Callers (batch drivers,
 * archivers, result tables) must key by the `id` returned here instead.
 */
export function researchNamedRunSpecs(base: ResearchSpec) {
  return researchCompositePresetIds.map((id) => ({
    id,
    spec: buildNamedResearchSpec(id, base),
  }));
}

/**
 * Cup/handle history windows are per-event (`historyStart` varies with the
 * detected shape), so the stock-wide `adjustedCoverage` price-factor check
 * is not fine-grained enough on its own: it only fails when a company action
 * actually perturbs the price-factor series, but a later, longer-reaching
 * candidate must not be able to admit an action that falls inside an
 * *earlier* candidate's narrower window just because that action happens to
 * have zero net price effect. Any recorded ex-dividend/rights/bonus action
 * inside `[start, end]` keeps that specific window's coverage undetermined,
 * independent of whether adjustmentFactors could still compute for it.
 */
function hasActionInWindow(
  stock: ResearchDataset["stocks"][number],
  start: string,
  end: string,
) {
  return stock.actions.some(
    (action) =>
      action.category === 1 && action.date >= start && action.date <= end,
  );
}

export async function runStrategyResearch(
  spec: ResearchSpec,
  dataset: ResearchDataset,
  marketEvidence: ResearchMarketEvidence | null,
  czsc: (bars: readonly Bar[], anchor?: 1 | 2 | 3) => Promise<CzscResult>,
  cancelled: () => boolean = () => false,
  progress: (
    symbol: string,
    date: string,
    done: number,
    total: number,
  ) => void = () => {},
  options: ResearchRunOptions = {},
) {
  validateResearchMethod(spec, dataset.method);
  const requestedSpec = spec;
  if (spec.strategy === "chan-wolf-daily-native")
    spec = {
      ...spec,
      risk: { fraction: 0.01, maxWeight: 0.2 },
      management: researchManagementSchema.parse({
        stop: { kind: "percent", fraction: 0.05 },
        trail: { kind: "fixed" },
      }),
    };
  if (spec.strategy === "wy-score-half-kelly")
    spec = {
      ...spec,
      risk: { fraction: 0.02, maxWeight: 0.3 },
      management: researchManagementSchema.parse({
        stop: { kind: "structure", buffer: 0 },
        trail: { kind: "fixed" },
        kelly: { provenance: "development-net-payoff", fraction: 0.5 },
      }),
    };
  if (isWyckoffHourly(spec.strategy) || spec.strategy === "wy-week-day-hour") {
    if (spec.wyckoffHourlyInputs === undefined)
      spec = {
        ...spec,
        wyckoffHourlyInputs: dataset.stocks.flatMap((stock) =>
          wyckoffHourlyFromMinutes(stock, dataset.calendar, spec.end),
        ),
      };
  }
  if (spec.management?.growthIntraday)
    assertGrowthIntradayWindow(spec.start, spec.end);
  const externalVolatility = spec.management?.volatilityStop;
  if (externalVolatility && isExternalVolatility(externalVolatility)) {
    if (!spec.management?.volatilityInputs?.length)
      throw new Error(
        "missing: Kase/Beta真实回测不可用，缺外部公式参数或原查表",
      );
    for (const stock of dataset.stocks)
      for (const date of dataset.calendar.filter(
        (d) => d >= spec.start && d <= spec.end,
      )) {
        const check = externalVolatilityPoint(
          externalVolatility,
          stock.bars,
          stock.symbol,
          date,
          spec.management.volatilityInputs,
          dataset.calendar,
        );
        if (check.status === "missing")
          throw new Error(
            `missing: ${stock.symbol} ${date} ${check.reason}；真实回测不可用`,
          );
      }
  }
  if (spec.management?.contextRisk) {
    if (!spec.management.contextRiskInputs?.length)
      throw new Error("missing: 真实回测不可用，缺历史事件或人工状态输入");
    for (const stock of dataset.stocks)
      for (const date of dataset.calendar.filter(
        (d) => d >= spec.start && d <= spec.end,
      )) {
        const check = contextRiskPoint(
          spec.management.contextRisk,
          spec.management.contextRiskInputs ?? [],
          stock.symbol,
          date,
          dataset.calendar,
        );
        if (check.status === "missing")
          throw new Error(
            `missing: ${stock.symbol} ${date} ${check.reason}；真实回测不可用`,
          );
      }
  }
  const events: ResearchEvent[] = [];
  const structureObservations: ResearchStructureObservation[] = [];
  const exclusions = [...dataset.excluded];
  const reversal =
    isVolumeReversal(spec.strategy) ||
    isVolumeContext(spec.strategy) ||
    isVolumeSequence(spec.strategy);
  const structure = isVolumeStructure(spec.strategy);
  const channel = isChannelStrategy(spec.strategy) ? spec.strategy : null;
  const breakout = isBreakoutRule(spec.strategy);
  const canslim = isCanslimResearch(spec.strategy);
  const priority = isCanslimPriority(spec.strategy);
  const cup =
    isCanslimCup(spec.strategy) || priority || isSepaResearch(spec.strategy);
  const canslimHigh = isCanslimHigh(spec.strategy);
  const canslimWarmup = canslimShapeWarmup(spec.strategy);
  const candle =
    isCandleStrategy(spec.strategy) ||
    isContinuation(spec.strategy) ||
    channel !== null ||
    breakout ||
    (canslim && !cup);
  const candleStarts = new Map(
    dataset.stocks.map((stock) => [
      stock.symbol,
      isSwingCore(spec.strategy) || spec.strategy === "sw-system-combined"
        ? (stock.bars[0]?.date ?? spec.start)
        : canslimHigh
          ? canslimHighWarmupStart(stock.bars, spec.start)
          : breakout || canslim
            ? (stock.bars[
                Math.max(
                  0,
                  stock.bars.findIndex((b) => b.date >= spec.start) -
                    (canslim ? canslimWarmup : 60),
                )
              ]?.date ?? spec.start)
            : channel
              ? channelWarmupStart(channel, stock.bars, spec.start)
              : candleWarmupStart(stock.bars, spec.start),
    ]),
  );
  const volume =
    isWyckoffHourly(spec.strategy) ||
    isWyckoffVsa(spec.strategy) ||
    isWyckoff(spec.strategy) ||
    isVolumePollution(spec.strategy) ||
    isVolumeAdapted(spec.strategy) ||
    isIndicatorCombination(spec.strategy) ||
    isVolumeIntraday(spec.strategy) ||
    isSwingMarket(spec.strategy) ||
    isExternalFormula(spec.strategy) ||
    isFormulaExample(spec.strategy) ||
    isPatternCombination(spec.strategy) ||
    isTechnicalMethod(spec.strategy) ||
    isVolumeStrategy(spec.strategy) ||
    reversal ||
    structure ||
    isVolumeFailure(spec.strategy);
  const volumeStarts = new Map(
    dataset.stocks.map((stock) => [
      stock.symbol,
      isWyckoffHourly(spec.strategy) ||
      isWyckoffVsa(spec.strategy) ||
      isWyckoff(spec.strategy) ||
      isVolumePollution(spec.strategy) ||
      isVolumeAdapted(spec.strategy) ||
      isIndicatorCombination(spec.strategy) ||
      isVolumeIntraday(spec.strategy) ||
      isSwingMarket(spec.strategy) ||
      isExternalFormula(spec.strategy) ||
      isFormulaExample(spec.strategy) ||
      isPatternCombination(spec.strategy) ||
      isTechnicalMethod(spec.strategy)
        ? (stock.bars[0]?.date ?? spec.start)
        : structure
          ? volumeStructureWarmupStart(stock.bars, spec.start)
          : reversal
            ? volumeReversalWarmupStart(stock.bars, spec.start)
            : volumeWarmupStart(stock.bars, spec.start, spec.strategy),
    ]),
  );
  const series = new Map(
    dataset.stocks.map((stock) => [stock.symbol, stock.bars]),
  );
  const eventSeries = new Map<string, Bar[]>();
  const adjustedCoverage = new Set<string>();
  const adjustedMinuteSeries = new Map<string, Bar[]>();
  for (const [index, stock] of dataset.stocks.entries()) {
    if (cancelled()) throw new Error("研究已取消");
    try {
      const adjusted = prepareResearchAdjustedCoverage(
        stock,
        dataset.actionCoverage,
      );
      // Only pattern (candle) and volume-price strategies read adjusted
      // price/volume for their signal, so only they must be excluded
      // wholesale when a complete adjustment prefix cannot be verified. A
      // strategy outside those buckets (e.g. chan-native) never asked for
      // adjusted prices before this coverage gate existed, so it must still
      // be able to run on the stock's raw bars when coverage is missing —
      // execution admission is unaffected by this fallback: `adjustedCoverage`
      // is only added when coverage is genuinely available, so the separate
      // actionCovered/lookup gate below still withholds trade execution.
      if (adjusted.status === "missing" && (candle || volume))
        throw new Error(adjusted.reason ?? "复权覆盖缺失");
      // Volume-dependent strategies need both the price coverage above and
      // volume comparability across any share-count-changing event; a
      // pattern-only strategy never reaches this branch's rejection because
      // it does not read bar.volume for its signal.
      if (
        volume &&
        adjusted.status === "available" &&
        adjusted.volumeCoverage === "missing"
      )
        throw new Error(adjusted.volumeReason ?? "量能可比性覆盖缺失");
      if (adjusted.status === "available") adjustedCoverage.add(stock.symbol);
      const priceCovered = adjusted.status === "available";
      const signalBars = !priceCovered
        ? stock.bars
        : volume
          ? adjusted.volumeAdjustedBars
          : adjusted.bars;
      const signalMinuteBars = !priceCovered
        ? (stock.minuteBars ?? [])
        : volume
          ? adjusted.volumeAdjustedMinuteBars
          : adjusted.minuteBars;
      adjustedMinuteSeries.set(stock.symbol, signalMinuteBars);
      const cacheSeriesHash = options.czscCache
        ? researchHash(signalBars)
        : null;
      const cachedCzsc =
        options.czscCache && cacheSeriesHash && options.czscCacheNamespace
          ? (prefix: readonly Bar[], anchor?: 1 | 2 | 3) => {
              const key = [
                options.czscCacheNamespace,
                cacheSeriesHash,
                prefix.length,
                prefix[0]?.date ?? "",
                prefix.at(-1)?.date ?? "",
                anchor ?? "none",
              ].join("|");
              const hit = options.czscCache!.get(key);
              if (hit) return hit;
              const pending = czsc(prefix, anchor);
              options.czscCache!.set(key, pending);
              return pending;
            }
          : czsc;
      const observed =
        spec.management?.growthIntraday === "SE-E-intraday50" ||
        spec.management?.growthIntraday === "SW02-last30"
          ? growthIntradayEntries(
              stock.symbol,
              signalBars,
              signalMinuteBars,
              dataset.calendar,
              spec,
            )
          : await researchSignals(
              stock.symbol,
              signalBars,
              spec,
              cachedCzsc,
              cancelled,
              (date) =>
                progress(stock.symbol, date, index, dataset.stocks.length),
              dataset.calendar,
              dataset.canslimMarket,
              (row) => structureObservations.push(row),
              signalMinuteBars,
              stock.volumeEvidence,
            );
      const accepted = cup
        ? observed.filter((event) => {
            const start = event.historyStart;
            const reason =
              !start || start > event.observedDate
                ? "杯柄事件缺少有效历史输入起点"
                : !adjustedCoverage.has(stock.symbol)
                  ? "杯柄选中形态窗口复权覆盖缺失"
                  : hasActionInWindow(stock, start, event.observedDate)
                    ? "杯柄选中形态窗口内存在未核验的公司行动记录，复权覆盖缺失"
                    : null;
            if (reason) {
              exclusions.push({
                symbol: stock.symbol,
                reason: `${event.observedDate}：${reason}`,
              });
              return false;
            }
            return true;
          })
        : observed;
      events.push(...accepted);
      // Signal/outcome prices are adjusted when coverage allows it; the raw
      // series above remains the execution source for the portfolio
      // simulation either way.
      eventSeries.set(stock.symbol, priceCovered ? adjusted.bars : stock.bars);
    } catch (error) {
      if (cancelled()) throw error;
      // A rejected stock must not be recalculated by the portfolio's exit
      // engine and turn one stock's exclusion into a whole-task failure.
      series.delete(stock.symbol);
      exclusions.push({
        symbol: stock.symbol,
        reason: error instanceof Error ? error.message : "策略计算失败",
      });
    }
  }
  const outcomes = researchOutcomes(
    events.filter((e) => e.side !== "exit"),
    eventSeries,
    dataset.benchmark.bars,
    dataset.calendar,
    spec.holdingDays,
    dataset.calendar.at(-1) ?? spec.start,
  ).map((outcome) =>
    outcome.event.partition === "development" &&
    outcome.exitDate !== null &&
    outcome.exitDate >= spec.validationStart
      ? {
          ...outcome,
          status: "pending" as const,
          grossReturn: null,
          benchmarkReturn: null,
          excessReturn: null,
          reason: "观察窗口跨入保留验证期，不计入开发期统计",
        }
      : outcome,
  );
  const lookup = marketEvidence
    ? researchEvidenceLookup(marketEvidence)
    : () => null;
  // A complete adjusted price series (adjustedCoverage) is the primary
  // company-action admission gate for execution lookup. When the GBBQ source
  // itself is entirely absent (dataset.actionCoverage === "missing"), no
  // internal price-factor coverage can ever be derived, so strategies that
  // never needed adjusted prices in the first place (i.e. outside the
  // candle/volume buckets, which fall back to raw bars above) may still be
  // admitted for execution via an explicit external assertion
  // (marketEvidence.corporateActionFree) — the same fallback the pre-coverage
  // design used, now scoped to only the missing-source case so it cannot
  // re-admit a stock whose GBBQ-derived coverage was verified and found
  // wanting. requiresActionPrefix strategies read history back to the
  // series' first bar, so their required proof window is the whole prefix,
  // not just spec.start.
  const requiresActionPrefix =
    isChanNative(spec.strategy) ||
    isChanC4(spec.strategy) ||
    (spec.management?.growthIntraday != null &&
      (isOpening(spec.management.growthIntraday) ||
        isMarketAdmission(spec.management.growthIntraday) ||
        isIntradayExecution(spec.management.growthIntraday) ||
        spec.management.growthIntraday === "SW02-last30")) ||
    !!spec.stopDiagnosis ||
    spec.management?.growthIntraday === "RK-C-swing-system" ||
    spec.management?.trail.kind === "volatility" ||
    !!spec.management?.riskPreset ||
    spec.management?.contextRisk === "rk-sector-risk" ||
    spec.management?.contextRisk === "rk-diversify" ||
    // A held-position stop diagnosis reads back to the position's own entry,
    // so its proof window is the prefix too, not spec.start.
    !!spec.riskRepair;
  const proofWindowStart = (symbol: string, bars: Bar[]) =>
    requiresActionPrefix
      ? (bars[0]?.date ?? spec.start)
      : volume
        ? volumeStarts.get(symbol)!
        : candle
          ? candleStarts.get(symbol)!
          : spec.start;
  /** The explicit external assertion, judged on its own window alone. */
  const proven = (symbol: string, bars: Bar[]) =>
    !!marketEvidence?.corporateActionFree.some(
      (coverage) =>
        coverage.symbol === symbol &&
        coverage.start <= proofWindowStart(symbol, bars) &&
        coverage.end >= spec.end,
    );
  // Locally-derived GBBQ price-factor coverage is the primary gate, and the
  // external provider assertion is only a fallback for the case where no
  // GBBQ source exists at all. `marketEvidence` is an imported third-party
  // export (see research-market-evidence.ts: "importing is not
  // verification"), so making it mandatory would put every real backtest at
  // the mercy of a file the workbench cannot produce — which is exactly the
  // admission blocker this coverage gate replaced. Scoping the fallback to
  // the missing-source case also keeps it from re-admitting a stock whose
  // GBBQ-derived coverage was computed and found wanting. The prefix window
  // above therefore only ever tightens the fallback, never the primary gate.
  const admitsAction = (symbol: string, bars: Bar[]) =>
    adjustedCoverage.has(symbol) ||
    (dataset.actionCoverage === "missing" && proven(symbol, bars));
  const actionCovered = new Set(
    dataset.stocks
      .filter((stock) => admitsAction(stock.symbol, stock.bars))
      .map((stock) => stock.symbol),
  );
  const repairActionCovered =
    !!spec.riskRepair &&
    admitsAction(
      spec.riskRepair!.symbol,
      series.get(spec.riskRepair!.symbol) ?? [],
    );
  const trainsAdmission = riskAdmissionNeedsTraining(
    spec.management?.riskPreset
      ? riskPresetAdmission(spec.management.riskPreset)
      : undefined,
  );
  const trainsMae = spec.management?.riskPreset === "rk-mae";
  let maeTraining: ResearchMaeTraining | null = null;
  const trainsKelly =
    trainsAdmission ||
    spec.management?.kelly?.provenance === "development-closed" ||
    spec.management?.kelly?.provenance === "development-net-payoff";
  let kellyTraining: ResearchKellyTraining | null = null;
  const partitions = (["development", "validation"] as const).map(
    (partition) => {
      const sample = outcomes.filter(
        (outcome) => outcome.event.partition === partition,
      );
      const partitionEvents = events.filter(
        (event) => event.partition === partition,
      );
      // A later candidate may reach further into history. Check each event
      // independently so it cannot revoke an earlier event's valid coverage.
      // Cup/handle history windows vary per event, so the stock-wide
      // adjustedCoverage price-factor check alone cannot tell whether *this*
      // event's own [historyStart, spec.end] slice is free of undisclosed
      // actions. That per-event slice still needs an explicit external
      // assertion (marketEvidence.corporateActionFree) — GBBQ coverage is
      // computed once for the whole bars array, not per dynamically-varying
      // event window, so it cannot express "this specific stretch is
      // additionally proven action-free" the way a later, longer-reaching
      // candidate requires without retroactively revoking an earlier,
      // narrower-windowed trade.
      const transactionEvents = cup
        ? partitionEvents.filter((event) => {
            const covered =
              adjustedCoverage.has(event.symbol) &&
              !!event.historyStart &&
              !!marketEvidence?.corporateActionFree.some(
                (coverage) =>
                  coverage.symbol === event.symbol &&
                  coverage.start <= event.historyStart! &&
                  coverage.end >= spec.end,
              );
            if (!covered)
              exclusions.push({
                symbol: event.symbol,
                reason: `${event.observedDate}：杯柄交易模拟缺少形态窗口无公司行动证明，保留事件观察`,
              });
            return covered;
          })
        : partitionEvents;
      const start =
        partition === "validation" ? spec.validationStart : spec.start;
      const beforeValidation =
        dataset.calendar.filter((day) => day < spec.validationStart).at(-1) ??
        spec.start;
      const end = partition === "validation" ? spec.end : beforeValidation;
      const { kelly: _kelly, ...referenceManagement } = (spec.management ??
        {}) as Partial<NonNullable<ResearchSpec["management"]>>;
      const partitionSpec =
        (trainsKelly || trainsMae) && partition === "development"
          ? {
              ...spec,
              start,
              end,
              management: (trainsAdmission || trainsMae
                ? (({ riskPreset: _riskPreset, ...rest }) => rest)(
                    referenceManagement,
                  )
                : referenceManagement) as NonNullable<
                ResearchSpec["management"]
              >,
            }
          : { ...spec, start, end };
      let simulation = marketEvidence
        ? researchPortfolio(
            partitionSpec,
            spec.management?.growthIntraday ? [] : transactionEvents,
            dataset.calendar,
            series,
            (symbol, date) =>
              actionCovered.has(symbol) ? lookup(symbol, date) : null,
            dataset.benchmark,
            trainsKelly && partition === "validation"
              ? kellyTraining
              : undefined,
            dataset.canslimMarket,
            trainsMae && partition === "validation" ? maeTraining : undefined,
          )
        : null;
      if (simulation && spec.management?.growthIntraday)
        simulation = researchGrowthIntraday(
          partitionSpec,
          transactionEvents,
          dataset.calendar,
          series,
          adjustedMinuteSeries,
          (symbol, date) =>
            actionCovered.has(symbol) ? lookup(symbol, date) : null,
          simulation,
        );
      if (trainsMae && partition === "development")
        maeTraining = researchMaeTraining(
          simulation?.trades ?? [],
          series,
          dataset.calendar,
          spec.start,
          spec.validationStart,
        );
      if (trainsKelly && partition === "development")
        kellyTraining = researchKellyTraining(
          simulation?.trades ?? [],
          spec.start,
          spec.validationStart,
        );
      return {
        ...(trainsMae
          ? {
              maeRole:
                partition === "development"
                  ? "reference-fixed-5pct"
                  : "validation-frozen-q90",
              maeTraining: partition === "validation" ? maeTraining : null,
            }
          : {}),
        ...(trainsAdmission
          ? {
              riskAdmissionRole:
                partition === "development"
                  ? "reference-without-admission"
                  : "validation-with-development-only-training",
            }
          : {}),
        ...(trainsKelly
          ? {
              kellyRole:
                partition === "development"
                  ? "reference-without-kelly"
                  : "validation-with-trained-kelly",
            }
          : {}),
        partition,
        events: sample.length,
        pending: sample.filter((row) => row.status === "pending").length,
        unavailable: sample.filter((row) => row.status === "unavailable")
          .length,
        eventStatistics: researchTradeStatistics(
          sample.flatMap((row) =>
            row.grossReturn === null ? [] : [row.grossReturn],
          ),
        ),
        simulation,
      };
    },
  );
  const trainingEvidence =
    trainsKelly && kellyTraining
      ? {
          ...(kellyTraining as ResearchKellyTraining),
          ...(spec.management?.kelly?.provenance === "development-net-payoff"
            ? { netPayoff: researchKellyNetPayoff(kellyTraining) }
            : {}),
          reference: {
            strategy: spec.strategy,
            specHash: researchHash({
              ...spec,
              end:
                dataset.calendar
                  .filter((day) => day < spec.validationStart)
                  .at(-1) ?? spec.start,
              management: (({ kelly: _ignored, ...rest }) => rest)(
                spec.management!,
              ),
            }),
            datasetHash: dataset.hash,
            marketEvidenceHash: marketEvidence
              ? researchHash(marketEvidence)
              : null,
            kelly: "disabled",
            cutoff: spec.validationStart,
          },
        }
      : null;
  const result = {
    ...(spec.wyckoffStructureInputs !== undefined
      ? { wyckoffStructureInputs: spec.wyckoffStructureInputs }
      : {}),
    ...(isWyckoff(spec.strategy) ||
    isWyckoffHourly(spec.strategy) ||
    isWyckoffVsa(spec.strategy) ||
    isChanNative(spec.strategy) ||
    isChanC4(spec.strategy)
      ? {
          structureObservations: structureObservations.sort(
            (a, b) =>
              a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol),
          ),
        }
      : {}),
    ...(spec.stopDiagnosis
      ? { stopDiagnosis: diagnoseStops(spec.stopDiagnosis) }
      : {}),
    ...(spec.riskRoute ? { riskRoute: spec.riskRoute } : {}),
    ...(spec.riskRepair
      ? {
          riskRepair: repairActionCovered
            ? {
                executionEvidenceAvailable: true,
                includedInSignalPortfolio: false,
                repaired: replayRiskRepair(
                  spec.riskRepair,
                  series.get(spec.riskRepair.symbol) ?? [],
                  dataset.calendar.filter((d) => d <= spec.end),
                  (date) => lookup(spec.riskRepair!.symbol, date),
                  spec.costs,
                ),
                control: replayRiskRepair(
                  spec.riskRepair,
                  series.get(spec.riskRepair.symbol) ?? [],
                  dataset.calendar.filter((d) => d <= spec.end),
                  (date) => lookup(spec.riskRepair!.symbol, date),
                  spec.costs,
                  false,
                ),
              }
            : {
                executionEvidenceAvailable: false,
                includedInSignalPortfolio: false,
                status: "missing",
                reason: "缺行情、交易规则或公司行动证明；不计算可成交修复",
              },
        }
      : {}),
    ...(spec.riskExtension
      ? { riskExtension: evaluateRiskExtension(spec.riskExtension) }
      : {}),
    ...(trainingEvidence
      ? {
          kellyTraining: {
            ...trainingEvidence,
            hash: researchHash(trainingEvidence),
          },
        }
      : {}),
    version: "strategy-research-result-1" as const,
    spec: requestedSpec,
    ...(["wy-score-half-kelly", "chan-wolf-daily-native"].includes(
      spec.strategy,
    )
      ? { effectiveSpec: spec }
      : {}),
    ...(dataset.method ? { method: dataset.method } : {}),
    datasetHash: dataset.hash,
    marketEvidenceHash: marketEvidence ? researchHash(marketEvidence) : null,
    events,
    outcomes,
    partitions,
    exclusions,
    warnings: [
      ...(spec.management?.growthIntraday
        ? [
            growthIntradayDescription,
            `日线输入区间：${dataset.stocks.map((s) => `${s.symbol} ${s.bars[0]?.date ?? "无"}至${s.bars.at(-1)?.date ?? "无"}`).join("；")}。五分钟输入区间：${dataset.stocks.map((s) => `${s.symbol} ${s.minuteBars?.[0]?.date ?? "无"}至${s.minuteBars?.at(-1)?.date ?? "无"}`).join("；")}。本次共同研究窗口${spec.start}至${spec.end}；逐日可用性见signalGaps。事件观察仍为日线次开盘固定持有基线，盘中真实成交比较见simulation，不混作相同入场收益。`,
          ]
        : []),
      ...(isCanslimMarketCombination(spec.strategy)
        ? researchCanslimMarketWarnings(
            dataset.calendar,
            dataset.canslimMarket,
            spec.start,
            spec.end,
          )
        : []),
      ...(spec.management?.kelly?.provenance === "development-net-payoff"
        ? [
            "回报倍数使用开发期盈利交易净损益金额均值除亏损交易净损益绝对值均值，零收益不进入两边均值；缺任一侧或计算无效则验证期不买入。这不是目标距离或净收益率均值比。",
          ]
        : []),
      ...(trainsAdmission
        ? [
            "风险准入预设：开发段关闭准入门槛形成参考成交，验证段只用其已闭合训练样本。riskAdmissionChecks保留阈值、缺失及全部非盈利样本；固定输入不是业绩证据。",
          ]
        : []),
      ...(trainsKelly && !trainsAdmission
        ? [
            "开发期为同入场/退出且关闭凯利的参考组合；仅验证开始前完整闭合净收益计胜率，零收益计非胜，至少30笔。验证期独立起算资金且固定该胜率，参考未平仓/验证期收益不参与，分数仍为人工假设，b按所选模式取人工值或开发期净损益均值比。",
          ]
        : []),
      ...(spec.management?.marketRegime
        ? [
            "大盘环境只影响交易买入，不过滤原始个股事件观察。交易日前需21根连续有效基准记录，按快照日历对齐；此日历尚非独立核验的交易所日历，缺失不可用。已有仓位保留原卖出规则。",
          ]
        : []),
      ...(priority
        ? [
            spec.strategy.includes("-scored-handles")
              ? "评分柄优先级合并U/W/V两分缩量浅柄及一分平稳柄，保留上半部、柄量比及总分至少6；先择形再确认突破，不等于只看总分。无公司行动证明覆盖完整输入前缀及研究期；杯柄事件类排除提示在此指优先级形态事件。"
              : "形态优先级先选严格合格杯柄、平台、碟形再确认突破；无公司行动证明覆盖整个输入前缀及研究期，因为排除更优先形态也需要历史证据。杯柄事件类排除提示在此指优先级形态事件。",
          ]
        : []),
      ...(cup && !priority
        ? [
            "杯柄按完整历史前缀识别，杯35至325条、柄至少5条且无额外上限；左杯沿前3条至确认日含已知除权则剔除该事件。每个事件独立核验所需窗口及研究期无公司行动证明，缺失只排除该事件的交易模拟，不让后续更长形态撤销早期成交；原研究期除权结算限制仍保留。固定持有及可选风控不等于完整CANSLIM，成交价含滑点须在原枢纽至105%内。",
          ]
        : []),
      ...(candle
        ? [
            canslimHigh
              ? "CANSLIM N2新高分档仅为独立价格因子实验；52周为364自然日且含测试日最高价，前后观察均可计算后才确认上穿。无公司行动证明需覆盖首个研究观察前一观察日减364自然日至期末；并非完整CANSLIM或历史证券池验证。沿用持有期及可选组合风控，无平台枢纽105%限制。"
              : isCanslimMarket(spec.strategy)
                ? "CANSLIM M因子独立市场实验，入口二值与细则分层分名，沪深300独立冻结；缺失不造上穿，无枢纽限价，个股公司行动证明覆盖研究期及前25根。"
                : spec.strategy.startsWith("canslim-volume-")
                  ? "CANSLIM S1近5日峰量/此前20日均量组件，二值、分层与暴跌排除版本独立；无公司行动证明覆盖研究期及前25根，固定持有及可选风控，无枢纽价格限制，不代表完整CANSLIM。"
                  : canslim
                    ? `CANSLIM${spec.strategy.includes("-saucer-") ? "碟形" : "平台"}价量交易需无公司行动证据覆盖研究期及前${canslimWarmup}根；${spec.strategy.endsWith("-hold3") ? "三日维持按研究日历对齐且每日最低价不低于原枢纽，第三日收盘确认。" : "直接突破版本未包含三日维持。"}固定持有期对照未包含完整财务、RS、M、催化或原文分批退出。成交价含滑点须在冻结枢纽至105%范围，越界取消。`
                    : breakout
                      ? "双突破信号使用后复权价格；交易模拟使用原始价格，且仅纳入复权覆盖完整的证券。"
                      : channel
                        ? `通道形态交易的无公司行动证据须覆盖研究期及前${channelWarmupBars(channel)}根预热；拟合及触边阈值是工程对照，不证明趋势延续或真实盈利。`
                        : "K线形态交易的无公司行动证据须覆盖研究期及前11根预热；几何定义和三根方向背景是工程对照，不能证明趋势末端或真实盈利。",
          ]
        : []),
      ...(volume
        ? [
            `量价信号使用后复权价格、量能按GBBQ流通股本比例调整；交易模拟使用原始价格与原始量，且仅纳入复权覆盖与量能可比性覆盖均完整的证券。研究期、候选等待及预热至少向前${structure ? 90 : reversal ? 81 : 71}根价格，并覆盖候选形成前${structure || reversal ? 60 : 20}个有效量能记录。未核验大宗、指数调整、尾盘量能、历史流通盘等污染，固定阈值仅为工程对照。`,
          ]
        : []),
      ...(!dataset.method
        ? ["旧数据快照未记录方法来源版本，不能追溯为当前技能版本"]
        : []),
      dataset.membership.warning,
      dataset.actionCoverage === "missing"
        ? "缺少公司行动文件，复权信号与交易模拟均保留missing，不用当前因子回填历史"
        : `信号使用后复权、成交使用原始价；复权覆盖完整 ${adjustedCoverage.size}/${dataset.stocks.length} 只，交易模拟仅准入这些证券`,
      marketEvidence
        ? `交易规则证据行 ${marketEvidence.rows.length} 条；缺行时保留“缺少当日交易限制依据”，不把信号观察计为成交`
        : "未提供交易规则证据，交易模拟保留missing",
      "导入的历史交易条件是外部来源断言，并未由程序独立验证；费用是固定实验参数",
      "开发期与验证期的资金分别从初始资金开始，跨区间未平仓保留；开发期跨入验证期的事件收益不计入开发期统计",
    ],
  };
  return { ...result, hash: researchHash(result) };
}
