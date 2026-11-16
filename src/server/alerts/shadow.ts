import type { StrategyObjectInput } from "trading-strategies";
import type { PortfolioInstrument } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";

export type ShadowRegistration = {
  startedAt: number;
  status: "shadow-candidate";
  active: boolean;
  trialSharpes: { value: number | null; reason: string | null }[];
  neighbors: { id: string; excess: number | null }[];
  sizing: "legacy" | "equal" | "volatility";
  completeMarketCycles: number;
  lowZoneCorroborated: boolean;
};
export type ShadowSample = {
  symbol: string;
  bar: Bar;
  benchmark: Bar;
  observedAt: number;
  completedAt: number;
  source: string;
  entry: boolean | null;
  exit: boolean | null;
  stop: number | null;
  actions: PortfolioInstrument["actions"];
};
export type ShadowProgress = {
  samples: ShadowSample[];
  days: string[];
  signals: number;
  paused: boolean;
  assessment: {
    at: number;
    eligible: boolean;
    reasons: string[];
    recommendation: string;
    coverage?: {
      gaps: { after: string | null; before: string }[];
      observedDays: number;
      assessedDays: number;
      windows: number;
      start: string | null;
      end: string | null;
      latestObserved: string | null;
    };
  } | null;
};
export type ShadowSummary = Pick<
  ShadowProgress,
  "signals" | "paused" | "assessment"
> & { days: number };
export const shadowLimits = { signals: 30, days: 60, samples: 100000 } as const;
/** Separate the15:00 physical close from the15:05 batch receipt window. */
export function shadowBarCompletedAt(
  market: StrategyObjectInput["market"],
  period: StrategyObjectInput["period"],
  date: string,
  evaluationCompletedAt: number,
) {
  return market === "cn-equity" && (period === "day" || period === "week")
    ? Date.parse(`${date.slice(0, 10)}T15:00:00+08:00`)
    : evaluationCompletedAt;
}
export function appendShadowSamples(
  previous: ShadowProgress | undefined,
  registration: ShadowRegistration,
  fresh: ShadowSample[],
): ShadowProgress {
  const next: ShadowProgress = previous
    ? { ...previous, samples: [...previous.samples], days: [...previous.days] }
    : { samples: [], days: [], signals: 0, paused: false, assessment: null };
  if (next.paused) return next;
  const seen = new Set(next.samples.map((s) => `${s.symbol}|${s.bar.date}`));
  for (const sample of fresh) {
    if (
      sample.observedAt < registration.startedAt ||
      sample.completedAt < registration.startedAt ||
      sample.observedAt < sample.completedAt ||
      Date.parse(sample.bar.date) <
        new Date(registration.startedAt).setUTCHours(0, 0, 0, 0)
    )
      continue;
    const key = `${sample.symbol}|${sample.bar.date}`;
    if (seen.has(key)) continue;
    if (next.samples.length >= shadowLimits.samples) {
      next.paused = true;
      break;
    }
    seen.add(key);
    next.samples.push(sample);
    if (sample.entry === true && sample.exit !== true) next.signals++;
    const day = sample.bar.date.slice(0, 10);
    if (!next.days.includes(day)) next.days.push(day);
  }
  next.days.sort();
  return next;
}
/** Shadow samples measure observed rule coverage only. They cannot reconstruct
 * portfolio P&L or replace the same-version paper conformance assessment. */
export function assessShadow(
  strategy: StrategyObjectInput,
  _registration: ShadowRegistration,
  progress: ShadowProgress,
  now: number,
  marketCalendar: readonly string[] = [],
): ShadowProgress["assessment"] {
  const symbols = [
    ...new Set(
      strategy.universe.kind === "symbols"
        ? strategy.universe.symbols
        : progress.samples.map((s) => s.symbol),
    ),
  ].sort();
  const benchmark = [
    ...new Map(
      progress.samples.map((s) => [s.benchmark.date, s.benchmark]),
    ).values(),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const gaps: { after: string | null; before: string }[] = [];
  let segment: Bar[] = [];
  const calendar = [...new Set(marketCalendar)].sort();
  const step =
    strategy.market === "crypto"
      ? (
          {
            day: 86400000,
            "4h": 14400000,
            "1h": 3600000,
            "15m": 900000,
            "5m": 300000,
          } as Partial<Record<StrategyObjectInput["period"], number>>
        )[strategy.period]
      : undefined;
  const observations = new Set(
    progress.samples.map((s) => `${s.symbol}|${s.bar.date}`),
  );
  for (const bar of benchmark) {
    const previous = segment.at(-1);
    const complete = symbols.every((symbol) =>
      observations.has(`${symbol}|${bar.date}`),
    );
    const consecutive =
      !previous ||
      (strategy.market === "crypto"
        ? step !== undefined &&
          Date.parse(bar.date) - Date.parse(previous.date) === step
        : calendar.indexOf(previous.date.slice(0, 10)) >= 0 &&
          calendar[calendar.indexOf(previous.date.slice(0, 10)) + 1] ===
            bar.date.slice(0, 10));
    if (!complete || !consecutive) {
      gaps.push({ after: previous?.date ?? null, before: bar.date });
      segment = [];
    }
    if (complete) segment.push(bar);
  }
  const reasons = ["shadow-observations-have-no-portfolio-distribution"];
  if (progress.paused) reasons.push("shadow-observation-capacity-reached");
  if (gaps.length) reasons.push("incomplete-shadow-observation-windows");
  if (
    progress.samples.some(
      (sample) => sample.entry === null || sample.exit === null,
    )
  )
    reasons.push("unknown-forward-rule-inputs");
  return {
    at: now,
    eligible: false,
    reasons,
    recommendation:
      "证据不足；影子信号计数不代表组合盈亏，资格以同版本纸面前推一致性为准",
    coverage: {
      gaps,
      observedDays: progress.days.length,
      assessedDays: new Set(segment.map((bar) => bar.date.slice(0, 10))).size,
      // Count actually captured complete bar windows, not fitted research folds.
      windows: benchmark.filter((bar) =>
        symbols.every((symbol) => observations.has(`${symbol}|${bar.date}`)),
      ).length,
      start: segment[0]?.date ?? null,
      end: segment.at(-1)?.date ?? null,
      latestObserved: benchmark.at(-1)?.date ?? null,
    },
  };
}
