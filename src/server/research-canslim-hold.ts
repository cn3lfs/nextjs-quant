import type { Bar } from "~/lib/domain";
import type { researchCanslimFlatPoint } from "./research-canslim-flat";
import type { researchCanslimSaucerPoint } from "./research-canslim-saucer";
import type { researchCanslimCupPoint } from "./research-canslim-cup";
import type { researchCanslimPriorityPoint } from "./research-canslim-priority";

type Point =
  | ReturnType<typeof researchCanslimPriorityPoint>
  | ReturnType<typeof researchCanslimFlatPoint>
  | ReturnType<typeof researchCanslimSaucerPoint>
  | ReturnType<typeof researchCanslimCupPoint>;
export function researchCanslimHold(
  points: readonly Point[],
  bars: readonly Bar[],
  calendar: readonly string[],
) {
  const days = new Map(calendar.map((date, index) => [date, index]));
  return points.map((point, index) => {
    const source = points[index - 3];
    const start = source ? days.get(source.date) : undefined;
    const window = bars.slice(index - 2, index + 1);
    const valid =
      source?.entry &&
      source.candidate &&
      start != null &&
      window.length === 3 &&
      window.every(
        (bar, offset) =>
          bar.date === calendar[start + offset + 1] &&
          [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
            (value) => Number.isFinite(value) && value > 0,
          ) &&
          bar.high >= Math.max(bar.open, bar.close) &&
          bar.low <= Math.min(bar.open, bar.close) &&
          bar.low >= source.candidate!.high,
      ) &&
      window[2]!.close <= source.maxEntryPrice!;
    return {
      ...point,
      entry: !!valid,
      candidate: valid ? source.candidate : null,
      maxEntryPrice: valid ? source.maxEntryPrice : null,
      // Preserve the original pivot's date separately from this confirmation date.
      ...(valid
        ? {
            ...("historyStart" in source
              ? { historyStart: source.historyStart }
              : {}),
            hold: {
              breakoutDate: source.date,
              confirmationDate: point.date,
              days: window.map((bar) => bar.date),
              rule: "low-at-or-above-pivot",
            },
          }
        : {}),
    };
  });
}
