import type { Bar } from "trading-strategy-core/bars";

export const fiveMinuteSessionTimes = Array.from({ length: 48 }, (_, i) => {
  const minutes = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
});
export function isCompleteFiveMinuteSession(
  times: readonly string[] | undefined,
) {
  return times?.join(",") === fiveMinuteSessionTimes.join(",");
}
/** Callers supply either verified benchmark days or locally observed days.
 * A local observation list cannot certify that an entire trading day is absent. */
export function expectedFiveMinuteWarmup(
  previousDays: readonly string[],
  warmupBars: number,
) {
  if (warmupBars === 0) return [];
  return previousDays
    .slice(-Math.ceil(warmupBars / 48))
    .flatMap((day) =>
      fiveMinuteSessionTimes.map((time) => `${day}T${time}:00+08:00`),
    )
    .slice(-warmupBars);
}
export function matchesFiveMinuteWarmup(
  bars: readonly Pick<Bar, "date">[],
  first: number,
  previousDays: readonly string[],
  warmupBars: number,
) {
  if (first < warmupBars) return false;
  const expected = expectedFiveMinuteWarmup(previousDays, warmupBars);
  return (
    expected.length === warmupBars &&
    bars
      .slice(first - warmupBars, first)
      .map((bar) => bar.date)
      .join(",") === expected.join(",")
  );
}
