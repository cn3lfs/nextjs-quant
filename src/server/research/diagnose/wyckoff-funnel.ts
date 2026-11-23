import {
  researchWyckoffSeries,
  type WyckoffPoint,
} from "trading-strategies/research/wyckoff/research-wyckoff";
import type { Bar } from "trading-strategy-core/bars";
import { ma } from "trading-strategy-core/indicators";

export type WyckoffFunnelStrategyId =
  "wy-lps-daily" | "wy-reaccumulation-daily" | "wy-trend-pullback-daily";
type Event = WyckoffPoint["events"][number];

export function analyzeWyckoffFunnel(
  strategyId: WyckoffFunnelStrategyId,
  bars: readonly Bar[],
  windowStart: string,
  windowEnd: string,
  calendar?: readonly string[],
) {
  if (windowStart > windowEnd) throw new Error("威科夫漏斗起止日期倒置");
  const observed = bars.filter((bar) => bar.date <= windowEnd);
  const series = researchWyckoffSeries(strategyId, observed, calendar);
  const trendPullback = strategyId === "wy-trend-pullback-daily";
  const reaccumulation = strategyId === "wy-reaccumulation-daily";
  const mean20 = trendPullback ? ma(observed, 20) : [];
  const mean60 = trendPullback ? ma(observed, 60) : [];
  const candidateKind = trendPullback ? "trend" : "lps";
  const result = {
    parentEvents: 0,
    pullbackShrinkage: 0,
    candidates: 0,
    nextDayVolumeConfirm: 0,
    entrySignals: 0,
    parentConfirmations: 0,
    carryInCandidates: 0,
    boundary:
      "父层按可尝试回踩的日线计数，SOS/JAC 实际确认次数另列。候选及确认采用策略原始事件。" +
      (trendPullback
        ? "趋势回调次日须守住候选低点，收盘突破候选高点且量至少为候选日前20日均量的1.5倍。"
        : "LPS/再吸筹次日须守住候选低点且收盘突破候选高点，量能要求发生在回踩缩量层。") +
      "窗口内确认的跨界候选回计至上游各层，入场按确认日计数。",
  };
  let parent: Event | undefined;
  let lastUsedParent: string | undefined;
  for (let index = 0; index < series.length; index++) {
    const point = series[index]!;
    const bar = observed[index]!;
    const inWindow = point.date >= windowStart;
    if (
      parent &&
      (point.reason ||
        index - parent.facts.index > 10 ||
        bar.low < parent.facts.level)
    )
      parent = undefined;

    // Confirmations become parents only after this bar's candidate check.
    const parentEligible = trendPullback
      ? index > 60 &&
        !point.structure &&
        mean20[index - 1]! > mean60[index - 1]! &&
        mean60[index - 1]! > mean60[index - 2]! &&
        mean20[index - 1]! > mean20[index - 2]!
      : !!parent &&
        parent.key !== lastUsedParent &&
        (!reaccumulation || parent.facts.trend);
    const eligible = !point.reason && parentEligible;
    if (inWindow && eligible) {
      result.parentEvents++;
      if (
        bar.volume < point.values.meanVolume * 0.5 &&
        bar.close < observed[index - 1]!.close
      )
        result.pullbackShrinkage++;
    }
    if (
      point.events.some(
        (event) => event.kind === "lps" && event.state === "candidate",
      )
    )
      lastUsedParent = parent?.key;
    for (const event of point.events) {
      if (
        event.state === "confirmed" &&
        (event.kind === "sos" || event.kind === "jac")
      ) {
        parent = event;
        if (inWindow) result.parentConfirmations++;
      }
      if (
        !inWindow ||
        event.kind !== candidateKind ||
        (reaccumulation && !event.facts.trend)
      )
        continue;
      if (event.state === "candidate") result.candidates++;
      if (event.state === "confirmed") {
        result.nextDayVolumeConfirm++;
        if (event.candidateAt < windowStart) {
          result.carryInCandidates++;
          result.parentEvents++;
          result.pullbackShrinkage++;
          result.candidates++;
        }
      }
    }
    if (inWindow && point.entry) result.entrySignals++;
  }
  return result;
}
