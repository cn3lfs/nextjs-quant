import type { Bar } from "~/lib/domain";
import type { CanslimResearchMarket } from "./research-canslim-market-score";
import { researchCanslimVolumeScore } from "./research-canslim-volume-score";

export function researchCanslimVolumeTier(
  id: "canslim-volume-tier" | "canslim-volume-tier-crash",
  bars: readonly Bar[],
  calendar: readonly string[],
  market?: CanslimResearchMarket,
) {
  const base = researchCanslimVolumeScore(bars, calendar);
  const dates = new Map(calendar.map((d, i) => [d, i]));
  const indices = new Map<string, number>();
  const ordered: boolean[] = [];
  market?.bars.forEach((b, i) => {
    ordered.push(!i || (ordered[i - 1]! && b.date > market.bars[i - 1]!.date));
    if (!indices.has(b.date)) indices.set(b.date, i);
  });
  let previous: number | null = null;
  return base.map((point, i) => {
    const crash = id.endsWith("crash");
    const day = dates.get(point.date),
      j = indices.get(point.date);
    const input =
      j == null ? [] : market!.bars.slice(Math.max(0, j - 5), j + 1);
    const marketValid =
      !crash ||
      (market?.symbol === "sh000300" &&
        !!market.source &&
        !!market.hash &&
        j != null &&
        ordered[j] === true &&
        day != null &&
        input.length === 6 &&
        input.every(
          (b, k) =>
            b.date === calendar[day - 5 + k] &&
            [b.open, b.high, b.low, b.close, b.volume].every(
              (v) => Number.isFinite(v) && v > 0,
            ) &&
            b.high >= Math.max(b.open, b.close, b.low) &&
            b.low <= Math.min(b.open, b.close),
        ));
    const excludedDates: string[] = [];
    const recent = bars.slice(Math.max(0, i - 4), i + 1).filter((b, k) => {
      if (!crash || !marketValid || i < 24) return true;
      const prior = bars[i - 5 + k]!;
      const exclude =
        input[k + 1]!.close <= input[k]!.close * 0.97 &&
        b.close < prior.close &&
        b.volume > prior.volume;
      if (exclude) excludedDates.push(b.date);
      return !exclude;
    });
    const mean = point.diagnostic.mean20;
    const peak =
      marketValid && mean !== null && recent.length
        ? Math.max(...recent.map((b) => b.volume))
        : null;
    const points =
      peak === null || mean === null
        ? null
        : peak >= mean * 2
          ? 8
          : peak >= mean * 1.5
            ? 6
            : peak >= mean * 1.2
              ? 3
              : 0;
    const result = {
      ...point,
      entry: previous !== null && previous < 8 && points === 8,
      reason:
        points === null
          ? "量能或市场窗口缺失/排除后无可用日"
          : previous === null
            ? "前一评分未知，不确认上穿"
            : null,
      diagnostic: {
        ...point.diagnostic,
        version: `${id}-1`,
        status: points === null ? "missing" : "computed",
        points,
        previousPoints: previous,
        peak5: peak,
        excludedDates,
        marketSource: crash ? (market?.source ?? null) : null,
        marketHash: crash ? (market?.hash ?? null) : null,
      },
    };
    previous = points;
    return result;
  });
}
