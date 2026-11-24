import {
  isNativeChanV3Profile,
  type StrategyObjectInput,
} from "trading-strategies";
import type { PortfolioRequest } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { Settings } from "~/lib/domain";
import {
  CausalPriceBasisError,
  refreshCausalPriceProof,
  type CausalPriceProof,
} from "../causal-price-basis";
import {
  prepareLabBacktest,
  usesNativeChan,
  usesExternalSignals,
  type FrozenLabBacktest,
  type LabExecutionProfile,
} from "../lab-backtest";
import { readBars } from "../../market/bar-store/read-bars";
import { attachNativeChanMulti, type NativeChanOptions } from "./chan-native";
import {
  attachGrowthPitSignals,
  isGrowthPitStrategyKey,
  type GrowthPitSignalOptions,
} from "./growth-pit";
import { isAStock } from "tstdx/local";
import {
  readGp29Evidence,
  resolveSessionEvidence,
  type CertifiedSuspensionDay,
} from "./session-evidence";
import type { StrategyDisclosures } from "./types";

export const BENCHMARK_CALENDAR_SYMBOL = "sh000001";

export type PrepareDiagnoseRequestInput = Omit<
  NativeChanOptions,
  "projectionVersion"
> &
  Pick<
    PortfolioRequest,
    | "accountMaxUniqueSymbols"
    | "accountMaxSymbolWeight"
    | "collectDailyDecisionCounts"
  > &
  Pick<GrowthPitSignalOptions, "indexBars" | "readFinancialHistory"> & {
    strategy: StrategyObjectInput;
    additionalStrategies?: readonly StrategyObjectInput[];
    sleeves?: PortfolioRequest["sleeves"];
    start: string;
    end: string;
    initial: number;
    riskPerTrade: number;
    maxPositions: number;
    costScenario: ResearchCostScenario;
    config: Settings;
    read?: typeof readBars;
    signal?: AbortSignal;
    forceCausalPrice: boolean;
    executionProfile?: LabExecutionProfile;
    maxParticipation?: number;
    capacityPolicy?: "clip" | "reject";
  };

export type DiagnoseSourceQuality = {
  symbol: string;
  dataAsOf: string | null;
  adjustment: string | null;
  priceRepaired: boolean;
  sourceNote: string | null;
  /** Unparsed GBBQ records attributed to this symbol. */
  gbbqIssueCount: number;
  /** Unparsed GBBQ records whose security cannot be decoded; these could
   * belong to any symbol and are not a per-symbol completeness claim. */
  gbbqUnattributedIssueCount: number;
  /** Category 13/14 warrant dates skipped under the record-only GBBQ policy. */
  skippedWarrants: string[];
  /** Bars inside the window but absent from the benchmark calendar, dropped
   * from replay only; actions and execution maps are left untouched. */
  offCalendarDates: string[];
  offCalendarNote: string | null;
};

export type PreparedDiagnoseRequest = Pick<
  StrategyDisclosures,
  "nativeChan" | "canslimPit" | "growthPit"
> & {
  frozen: FrozenLabBacktest;
  calendar: string[];
  benchmarkBars?: readonly Bar[];
  dataQuality: DiagnoseSourceQuality[];
  suspensionCertificates?: CertifiedSuspensionDay[];
};

function sourceQuality(sources: readonly Record<string, unknown>[]) {
  return sources.map((source) => ({
    symbol: typeof source.symbol === "string" ? source.symbol : "",
    dataAsOf: typeof source.dataAsOf === "string" ? source.dataAsOf : null,
    adjustment:
      typeof source.adjustment === "string" ? source.adjustment : null,
    priceRepaired: source.priceRepaired === true,
    sourceNote:
      typeof source.sourceNote === "string" ? source.sourceNote : null,
    gbbqIssueCount:
      typeof source.gbbqIssueCount === "number" ? source.gbbqIssueCount : 0,
    gbbqUnattributedIssueCount:
      typeof source.gbbqUnattributedIssueCount === "number"
        ? source.gbbqUnattributedIssueCount
        : 0,
    skippedWarrants: Array.isArray(source.skippedWarrants)
      ? source.skippedWarrants.filter(
          (date): date is string => typeof date === "string",
        )
      : [],
    offCalendarDates: Array.isArray(source.offCalendarDates)
      ? source.offCalendarDates.filter(
          (date): date is string => typeof date === "string",
        )
      : [],
    offCalendarNote:
      typeof source.offCalendarNote === "string"
        ? source.offCalendarNote
        : null,
  }));
}

/**
 * Reuse the lab loader for bars, causal prices, corporate actions and per-date
 * execution limits, then swap the union calendar for the benchmark's trading
 * days so a suspended stock stays a missing bar instead of disappearing.
 * Dropping replay bars also re-binds each frozen causal-price proof to the
 * filtered series; a proof whose anchor bar was dropped is rejected rather
 * than left stale.
 */
export async function prepareDiagnoseRequest(
  input: PrepareDiagnoseRequestInput,
): Promise<PreparedDiagnoseRequest> {
  const strategies = [input.strategy, ...(input.additionalStrategies ?? [])];
  const multi = strategies.length > 1;
  if (multi) {
    const universe = input.strategy.universe;
    if (
      universe.kind !== "symbols" ||
      strategies.some(
        (s) =>
          s.market !== input.strategy.market ||
          s.period !== input.strategy.period ||
          s.universe.kind !== "symbols" ||
          s.universe.symbols.length !== universe.symbols.length ||
          s.universe.symbols.some(
            (symbol) => !universe.symbols.includes(symbol),
          ),
      )
    )
      throw new Error("多策略诊断需要相同市场、周期及证券池");
    const ids = new Set(input.sleeves?.map((s) => s.id));
    if (
      ids.size !== strategies.length ||
      ids.size !== input.sleeves?.length ||
      new Set(strategies.map((s) => s.id)).size !== strategies.length ||
      new Set(strategies.map((s) => s.sleeve)).size !== strategies.length ||
      strategies.some((s) => !ids.has(s.sleeve))
    )
      throw new Error("多策略诊断需要唯一策略及一一对应的独立分仓");
  }
  const usesV3 = (s: StrategyObjectInput) =>
    s.entry.kind === "external" && isNativeChanV3Profile(s.entry.id);
  const nativeStrategies = strategies.filter(
    (s) => usesNativeChan(s) || usesV3(s),
  );
  const frozen = await prepareLabBacktest(
    {
      type: "lab-backtest",
      input: {
        source: "local",
        strategy: input.strategy,
        start: input.start,
        end: input.end,
        initial: input.initial,
        riskPerTrade: input.riskPerTrade,
        maxPositions: input.maxPositions,
        costScenario: input.costScenario,
      },
    },
    undefined,
    input.read,
    input.signal,
    {
      config: input.config,
      allowNativeChan: nativeStrategies.length > 0,
      allowExternalSignals: strategies.some(usesExternalSignals),
      forceCausalPrice: multi || input.forceCausalPrice,
      dataQualityMode: "record-only",
      gbbqIssuePolicy: "record-only",
      executionProfile: input.executionProfile,
      maxParticipation: input.maxParticipation,
      capacityPolicy: input.capacityPolicy,
    },
  );
  input.signal?.throwIfAborted();
  const benchmark = await (input.read ?? readBars)({
    instrument: { market: "cn-equity", symbol: BENCHMARK_CALENDAR_SYMBOL },
    root: input.config.tdxRoot,
    period: "day",
    adjustment: "none",
    live: false,
  });
  const evidenceCalendar = benchmark.bars.map((bar) => bar.date);
  const benchmarkBars = benchmark.bars.filter((bar) => bar.date <= input.end);
  const signalCalendar = benchmarkBars.map((bar) => bar.date);
  const calendar = signalCalendar.filter((date) => date >= input.start);
  if (!calendar.length)
    throw new Error(
      `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 在 ${input.start} 至 ${input.end} 无交易日`,
    );
  // The benchmark dates replace the union calendar, so a stock bar on a day
  // the index lacks would silently disappear. Bars before `start` are kept on
  // purpose: they are the strategy warmup. A handful of early Shenzhen special
  // sessions can put a stock bar outside the Shanghai benchmark calendar; when
  // that stays below a small share of the window, drop only those replay bars
  // and disclose them, rather than blocking the whole cell or synthesizing a
  // date. A larger gap is still a benchmark-calendar defect.
  const calendarSet = new Set(calendar);
  const { start, end } = frozen.request;
  const suspensionCertificates: CertifiedSuspensionDay[] = [];
  for (const instrument of frozen.request.instruments) {
    const inWindowBars = instrument.bars.filter((bar) => {
      const date = bar.date.slice(0, 10);
      return date >= start && date <= end;
    });
    // Daily bars: the unique dates are exactly the sessions that will be
    // dropped from both bar arrays.
    const offCalendar = [
      ...new Set(
        inWindowBars
          .map((bar) => bar.date.slice(0, 10))
          .filter((date) => !calendarSet.has(date)),
      ),
    ].sort();
    if (
      isAStock(instrument.symbol) &&
      inWindowBars.length - offCalendar.length < calendar.length
    ) {
      const gp29 = await readGp29Evidence(
        input.config.tdxRoot,
        instrument.symbol,
      );
      const { certifiedSuspensions } = resolveSessionEvidence({
        symbol: instrument.symbol,
        calendar: evidenceCalendar.filter(
          (date) => date >= (instrument.bars[0]?.date ?? start),
        ),
        replayEnd: end,
        bars: instrument.bars,
        asOf: new Date().toISOString(),
        gp29,
      });
      const certificates = certifiedSuspensions.filter((day) =>
        calendarSet.has(day.date),
      );
      if (certificates.length) {
        instrument.certifiedSuspensions = certificates.map(
          ({ symbol, date, resumptionDate }) => ({
            symbol,
            date,
            resumptionDate,
          }),
        );
        suspensionCertificates.push(...certificates);
      }
    }
    if (!offCalendar.length) continue;
    const threshold = Math.max(20, Math.floor(inWindowBars.length * 0.005));
    if (offCalendar.length > threshold) {
      const shown = offCalendar.slice(0, 5).join(", ");
      throw new Error(
        `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 缺少 ${instrument.symbol} 的交易日：${shown}${offCalendar.length > 5 ? ` 等 ${offCalendar.length} 个` : ""}`,
      );
    }
    const dropped = new Set(offCalendar);
    const sharedBars = instrument.signalBars === instrument.bars;
    const bars = instrument.bars.filter(
      (bar) => !dropped.has(bar.date.slice(0, 10)),
    );
    instrument.bars = bars;
    instrument.signalBars = sharedBars
      ? bars
      : instrument.signalBars.filter(
          (bar) => !dropped.has(bar.date.slice(0, 10)),
        );
    // Actions and execution maps keep their original dates; the engine maps a
    // non-calendar action date to the next calendar session on its own.
    const note = `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 不含该标的 ${offCalendar.length} 个交易日；为对齐回放日历，已从 bars/signalBars 删除这些 bar（未合成日期，未改公司行动或执行映射）`;
    const source = frozen.sources.find(
      (row) => row.symbol === instrument.symbol,
    );
    // The lab froze the causal series hash over the unfiltered arrays. Re-bind
    // it to the filtered pair so a later proof check sees the actual replay
    // series. Without a proof (non-causal strategies) there is nothing to do.
    const proof = source?.causalPrice as CausalPriceProof | undefined;
    if (proof && source) {
      const refreshed = refreshCausalPriceProof(
        proof,
        instrument.bars,
        instrument.signalBars,
      );
      if (!refreshed)
        throw new CausalPriceBasisError(
          `${instrument.symbol}：因果价格证明无法刷新：固定锚点原始 bar ${proof.anchorDate} 已被基准日历过滤，价格基失去锚点`,
        );
      source.causalPrice = refreshed;
    }
    if (source) {
      source.offCalendarDates = offCalendar;
      source.offCalendarNote = note;
    } else
      frozen.sources.push({
        symbol: instrument.symbol,
        offCalendarDates: offCalendar,
        offCalendarNote: note,
      });
  }
  frozen.request.calendar = calendar;
  frozen.request.observationDetail = "full";
  if (multi) frozen.request.strategies = strategies;
  if (input.sleeves) frozen.request.sleeves = input.sleeves;
  for (const key of [
    "accountMaxUniqueSymbols",
    "accountMaxSymbolWeight",
  ] as const)
    if (input[key] !== undefined) frozen.request[key] = input[key];
  if (input.collectDailyDecisionCounts !== undefined)
    frozen.request.collectDailyDecisionCounts =
      input.collectDailyDecisionCounts;
  input.signal?.throwIfAborted();
  const disclosures: StrategyDisclosures = {};
  if (nativeStrategies.length) {
    const rows = await attachNativeChanMulti(frozen, {
      ...input,
      projectionVersion: nativeStrategies.some(usesV3) ? 3 : undefined,
    });
    disclosures.nativeChan = nativeStrategies.flatMap((strategy) =>
      rows.map(({ zdStop, zdAtrStop, ...row }) => ({
        ...row,
        ...(multi && { strategyKey: strategy.id.replace(/^diag-/, "") }),
        ...(strategy.exit.stop?.kind === "structure" &&
          strategy.exit.stop.field === "chan-zd" &&
          zdStop && { zdStop }),
        ...(strategy.exit.stop?.kind === "structure" &&
          strategy.exit.stop.field === "chan-zd-atr" &&
          zdAtrStop && { zdAtrStop }),
      })),
    );
  }
  for (const strategy of strategies) {
    const growthKeys = new Set(
      [strategy.entry, strategy.exit.rule].flatMap((rule) =>
        rule?.kind === "external" && isGrowthPitStrategyKey(rule.id)
          ? [rule.id]
          : [],
      ),
    );
    for (const key of growthKeys) {
      input.signal?.throwIfAborted();
      const attached = await attachGrowthPitSignals(key, frozen, {
        tdxRoot: input.config.tdxRoot,
        signalCalendar,
        indexBars: input.indexBars,
        readFinancialHistory: input.readFinancialHistory,
      });
      const strategyKey = strategy.id.replace(/^diag-/, "");
      const byRule = multi || growthKeys.size > 1;
      const rows = byRule
        ? attached.map((row) => ({ ...row, strategyKey, ruleId: key }))
        : attached;
      (disclosures.growthPit ??= []).push(...rows);
      if (key.startsWith("research-canslim-"))
        (disclosures.canslimPit ??= []).push(...rows);
      for (const row of rows) {
        const source = frozen.sources.find(
          (source) => source.symbol === row.symbol,
        );
        if (source && byRule) {
          const byStrategy = (source.growthPitByStrategy ??= {}) as Record<
            string,
            Record<string, typeof row>
          >;
          byStrategy[strategyKey] = { ...byStrategy[strategyKey], [key]: row };
        } else if (source) {
          source.growthPit = row;
          if (key.startsWith("research-canslim-")) source.canslimPit = row;
        }
      }
    }
  }
  if (multi || (disclosures.growthPit ?? []).some((row) => row.strategyKey))
    for (const { external } of frozen.request.instruments) {
      if (external?.signals)
        external.signals = [...external.signals].sort(
          (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
        );
      if (external?.levels)
        external.levels = [...external.levels].sort(
          (a, b) =>
            a.date.localeCompare(b.date) || a.field.localeCompare(b.field),
        );
    }
  return {
    frozen,
    calendar,
    benchmarkBars,
    suspensionCertificates,
    dataQuality: sourceQuality(frozen.sources),
    ...disclosures,
  };
}
