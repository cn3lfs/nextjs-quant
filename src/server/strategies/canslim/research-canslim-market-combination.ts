import type { Bar } from "~/lib/domain";
import type { CanslimMarketCombinationId } from "~/lib/research/methods/canslim/research-canslim-market-strategies";
import {
  researchCanslimMarketScore,
  type CanslimResearchMarket,
} from "./research-canslim-market-score";
import type { researchCanslimPriorityPoint } from "./research-canslim-priority";

/** Persist low-score warnings even when the entry filter emits no buy event. */
export function researchCanslimMarketWarnings(
  calendar: readonly string[],
  market: CanslimResearchMarket | undefined,
  start: string,
  end: string,
) {
  if (!market) return [];
  const series = [
    "canslim-market-tier-ma250",
    "canslim-market-tier-follow10",
    "canslim-market-tier-distribution20",
  ].map((id) =>
    researchCanslimMarketScore(
      id as
        | "canslim-market-tier-ma250"
        | "canslim-market-tier-follow10"
        | "canslim-market-tier-distribution20",
      market.bars,
      calendar,
      market,
    ),
  );
  return market.bars.flatMap((bar, i) => {
    if (bar.date < start || bar.date > end) return [];
    const points = series.map((values) => values[i]!.diagnostic.points);
    if (points.some((p) => p === null)) return [];
    const total = points.reduce<number>((sum, p) => sum + p!, 0);
    return total < 6
      ? [
          `${bar.date} 沪深300 M=${total}低于6：市场环境极差，形态分析继续，禁止做多。`,
        ]
      : [];
  });
}

export function researchCanslimMarketCombination(
  id: CanslimMarketCombinationId,
  points: readonly ReturnType<typeof researchCanslimPriorityPoint>[],
  bars: readonly Bar[],
  calendar: readonly string[],
  market?: CanslimResearchMarket,
) {
  const scores = [
    "canslim-market-tier-ma250",
    "canslim-market-tier-follow10",
    "canslim-market-tier-distribution20",
  ] as const;
  const series = scores.map((score) =>
    researchCanslimMarketScore(score, bars, calendar, market),
  );
  return points.map((point, i) => {
    const parts = series.map((values) => values[i]!.diagnostic);
    const total = parts.every((p) => p.points !== null)
      ? parts.reduce((sum, p) => sum + p.points!, 0)
      : null;
    const allowed =
      total !== null &&
      total >= 6 &&
      (!id.endsWith("trend") ||
        (parts[0]!.points === 10 && parts[1]!.points === 8));
    const day = calendar.indexOf(point.date);
    const start = Math.max(0, i - 140);
    const complete =
      day >= 0 &&
      bars
        .slice(start, i + 1)
        .every((bar, k) => bar.date === calendar[day - (i - start) + k]);
    return {
      ...point,
      entry: point.entry && allowed && complete,
      reason:
        point.reason ??
        (!complete
          ? "形态研究日历缺日"
          : total === null
            ? "市场分项缺失，不允许入场"
            : null),
      market: {
        total,
        parts,
        allowed,
        warning:
          total !== null && total < 6
            ? "M因子低于6：市场环境极差；继续分析但禁止做多"
            : null,
      },
    };
  });
}
