import { researchCanslimWeekly } from "./research-canslim-weekly";
import type { Bar, Snapshot } from "~/lib/domain";
import type { SepaResearchId } from "~/lib/research-sepa-strategies";
import { sepaTrendFacts } from "./sepa-trend";
import { vcpFacts } from "./vcp";

const snapshot = (bars: readonly Bar[]): Snapshot => ({
  id: "research-prefix",
  hash: "research-prefix",
  symbol: "research",
  period: "day",
  source: "research-dataset",
  adjustment: "none",
  historicalAsOf: bars.at(-1)?.date,
  createdAt: 0,
  bars: [...bars],
});
const valid = (b: Bar) =>
  [b.open, b.high, b.low, b.close, b.volume].every(
    (v) => Number.isFinite(v) && v > 0,
  ) &&
  b.high >= Math.max(b.open, b.close, b.low) &&
  b.low <= Math.min(b.open, b.close);
/** Source section 8 score, with an explicit deterministic rising-leg interpretation. */
export function sepaVcpScore(bars: readonly Bar[]) {
  const facts = vcpFacts(snapshot(bars));
  if (!facts.applicable || !facts.checks || !facts.contractions)
    return { score: null, facts, risingStart: null, consolidationRatio: null };
  const window = bars.slice(-60),
    first = facts.contractions[0],
    last = facts.contractions.at(-1);
  if (!first || !last || first.start < 1)
    return { score: null, facts, risingStart: null, consolidationRatio: null };
  let low = 0;
  for (let i = 1; i < first.start; i++)
    if (window[i]!.close <= window[low]!.close) low = i;
  const rising = window.slice(low, first.start),
    consolidation = window.slice(first.start);
  const mean = (items: readonly Bar[]) =>
    items.reduce((s, b) => s + b.volume / items.length, 0);
  const ratio =
    window[first.start]!.close > window[low]!.close
      ? mean(consolidation) / mean(rising)
      : null;
  const checks = facts.checks;
  const ready =
    ratio !== null &&
    Number.isFinite(ratio) &&
    Object.entries(checks)
      .filter(([key]) => key !== "consolidationVolumeVersusUptrend")
      .every(([, v]) => v !== null);
  const n = facts.contractions.length;
  const score = ready
    ? (n === 2 ? 2 : n === 3 || n === 4 ? 3 : 0) +
      (checks.shrinkingAtLeast30Percent ? 2 : 0) +
      (last.depthPercent <= 5 ? 2 : last.depthPercent <= 10 ? 1 : 0) +
      (checks.amplitudeAtMost1Point5 ? 1 : 0) +
      (ratio! < 0.6 ? 1 : 0) +
      (checks.finalVolumeDry ? 1 : 0) +
      (checks.duration15To120Bars ? 1 : 0)
    : null;
  return {
    score,
    facts,
    risingStart: window[low]!.date,
    consolidationRatio: ratio,
  };
}
export type SepaPoint = {
  date: string;
  entry: boolean;
  exit: boolean;
  reason: string | null;
  values: { close: number | null };
  candidate: { high: number } | null;
  maxEntryPrice: number | null;
  historyStart: string | null;
  weeklyReduction?: ReturnType<
    typeof researchCanslimWeekly
  >[number]["weeklyReduction"];
  retest?: { breakoutDate: string; pivot: number; confirmed: boolean } | null;
  trend?: ReturnType<typeof sepaTrendFacts>;
  pattern?: ReturnType<typeof sepaVcpScore>;
  volume?: { period: number; threshold: number; average: number };
};
export function researchSepaSeries(
  id: SepaResearchId,
  bars: readonly Bar[],
  calendar: readonly string[] = bars.map((b) => b.date),
): SepaPoint[] {
  const dates = new Map(calendar.map((date, i) => [date, i]));
  const points = bars.map((bar, index) => {
    const prefix = bars.slice(0, index),
      prior = bars[index - 1];
    const point = {
      date: bar.date,
      entry: false,
      exit: false,
      reason: null as string | null,
      values: { close: Number.isFinite(bar.close) ? bar.close : null },
      candidate: null as { high: number } | null,
      maxEntryPrice: null as number | null,
      historyStart: null as string | null,
    };
    const day = dates.get(bar.date);
    // The production benchmark keeps only 250 warmup bars; stock history is full.
    // MA120 direction needs 140 prior observations, not the entire listing history.
    const windowStart = Math.max(0, index - 140);
    const complete =
      day != null &&
      bars.slice(0, index + 1).every(valid) &&
      bars
        .slice(windowStart, index + 1)
        .every((b, i) => b.date === calendar[day - (index - windowStart) + i]);
    if (!complete || !prior)
      return { ...point, reason: "历史OHLCV或研究日历不完整" };
    const trend = sepaTrendFacts(snapshot(prefix));
    const checks = Object.entries(trend.checks)
      .filter(([key]) => key !== "relativeStrength85")
      .map(([, value]) => value);
    if (checks.some((v) => v === null))
      return { ...point, reason: "趋势预热不足（含52周）" };
    const pattern = sepaVcpScore(prefix),
      pivot = pattern.facts.pivot?.price;
    const period = id === "sepa-vcp-volume50" ? 50 : 20,
      threshold =
        id === "sepa-vcp-volume2" ? 2 : id === "sepa-vcp-volume25" ? 2.5 : 1.5;
    const average = prefix
      .slice(-period)
      .reduce((s, b) => s + b.volume / period, 0);
    const average20 = prefix.slice(-20).reduce((s, b) => s + b.volume / 20, 0);
    const entry =
      checks.every((v) => v === true) &&
      pattern.score !== null &&
      pattern.score >= 6 &&
      pattern.facts.checks?.minimumTwoContractions === true &&
      pattern.facts.checks.shrinkingAtLeast30Percent === true &&
      pivot != null &&
      prior.close <= pivot * 1.01 &&
      bar.close > pivot * 1.01 &&
      bar.close <= pivot * 1.05 &&
      bar.volume >= average * threshold;
    return {
      ...point,
      entry,
      exit:
        id === "sepa-vcp-bear4" &&
        bar.close < prior.close * 0.96 &&
        bar.volume > average20 * 1.5,
      candidate: entry ? { high: pivot! } : null,
      maxEntryPrice: entry ? pivot! * 1.05 : null,
      historyStart: bars[0]!.date,
      trend,
      pattern,
      volume: { period, threshold, average },
    };
  });
  if (id === "sepa-vcp-weekly10-half")
    return researchCanslimWeekly(points, bars, calendar);
  if (id !== "sepa-vcp-retest") return points;
  let waiting: {
    date: string;
    index: number;
    pivot: number;
    historyStart: string;
  } | null = null;
  return points.map((point, index) => {
    const bar = bars[index]!,
      day = dates.get(bar.date)!;
    const pending = waiting;
    let entry = false;
    if (pending) {
      const age = day - pending.index;
      if (
        point.reason ||
        age > 10 ||
        bar.low < pending.pivot ||
        bar.close > pending.pivot * 1.05
      )
        waiting = null;
      else if (
        age >= 1 &&
        bar.low <= pending.pivot * 1.01 &&
        bar.close > pending.pivot * 1.01 &&
        "volume" in point &&
        point.volume &&
        bar.volume >= point.volume.average * 1.5
      ) {
        entry = true;
        waiting = null;
      } else if (age === 10) waiting = null;
    }
    if (!pending && point.entry && point.candidate)
      waiting = {
        date: bar.date,
        index: day,
        pivot: point.candidate.high,
        historyStart: point.historyStart!,
      };
    return {
      ...point,
      entry,
      candidate: entry ? { high: pending!.pivot } : null,
      maxEntryPrice: entry ? pending!.pivot * 1.05 : null,
      historyStart: entry ? pending!.historyStart : point.historyStart,
      retest: pending
        ? { breakoutDate: pending.date, pivot: pending.pivot, confirmed: entry }
        : null,
    };
  });
}
