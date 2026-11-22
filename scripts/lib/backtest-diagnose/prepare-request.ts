import type { StrategyObjectInput } from "trading-strategies";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { Settings } from "../../../src/lib/domain";
import {
  CausalPriceBasisError,
  refreshCausalPriceProof,
  type CausalPriceProof,
} from "../../../src/server/research/causal-price-basis";
import {
  prepareLabBacktest,
  type FrozenLabBacktest,
} from "../../../src/server/research/lab-backtest";
import { readBars } from "../../../src/server/market/bar-store/read-bars";

export const BENCHMARK_CALENDAR_SYMBOL = "sh000001";

export type PrepareDiagnoseRequestInput = {
  strategy: StrategyObjectInput;
  start: string;
  end: string;
  initial: number;
  riskPerTrade: number;
  maxPositions: number;
  costScenario: ResearchCostScenario;
  config: Settings;
  forceCausalPrice: boolean;
};

export type DiagnoseSourceQuality = {
  symbol: string;
  dataAsOf: string | null;
  adjustment: string | null;
  priceRepaired: boolean;
  sourceNote: string | null;
  /** Whole-file unparsed GBBQ records; not a per-symbol completeness claim. */
  gbbqIssueCount: number;
  /** Category 13/14 warrant dates skipped under the record-only GBBQ policy. */
  skippedWarrants: string[];
  /** Bars inside the window but absent from the benchmark calendar, dropped
   * from replay only; actions and execution maps are left untouched. */
  offCalendarDates: string[];
  offCalendarNote: string | null;
};

export type PreparedDiagnoseRequest = {
  frozen: FrozenLabBacktest;
  calendar: string[];
  dataQuality: DiagnoseSourceQuality[];
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
    undefined,
    undefined,
    {
      config: input.config,
      forceCausalPrice: input.forceCausalPrice,
      dataQualityMode: "record-only",
      gbbqIssuePolicy: "record-only",
    },
  );
  const benchmark = await readBars({
    instrument: { market: "cn-equity", symbol: BENCHMARK_CALENDAR_SYMBOL },
    root: input.config.tdxRoot,
    period: "day",
    adjustment: "none",
    to: input.end,
    live: false,
  });
  const calendar = benchmark.bars
    .map((bar) => bar.date)
    .filter(
      (date) =>
        date.slice(0, 10) >= input.start && date.slice(0, 10) <= input.end,
    );
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
  return {
    frozen,
    calendar,
    dataQuality: sourceQuality(frozen.sources),
  };
}
