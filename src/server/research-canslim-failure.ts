import type { Bar } from "~/lib/domain";
import type { researchCanslimPriorityPoint } from "./research-canslim-priority";

/** Breakout-relative calendar, not days since a possibly delayed purchase. */
export function researchCanslimFailure(
  points: readonly ReturnType<typeof researchCanslimPriorityPoint>[],
  bars: readonly Bar[],
  calendar: readonly string[],
  trigger: "low" | "close",
) {
  const dates = new Map(calendar.map((date, index) => [date, index]));
  const byDate = new Map(points.map((point) => [point.date, point]));
  const barByDate = new Map(bars.map((bar) => [bar.date, bar]));
  return points.map((point) => {
    const bar = barByDate.get(point.date);
    const index = dates.get(point.date);
    const valid =
      bar &&
      [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
        (value) => Number.isFinite(value) && value > 0,
      ) &&
      bar.high >= Math.max(bar.open, bar.close, bar.low) &&
      bar.low <= Math.min(bar.open, bar.close);
    const pivotFailures: {
      breakoutDate: string;
      confirmationDate: string;
      pivot: number;
      value: number;
      day: number;
      trigger: "low" | "close";
    }[] = [];
    if (valid && index != null)
      for (let day = 1; day <= 3; day++) {
        const date = calendar[index - day];
        const source = date ? byDate.get(date) : undefined;
        if (
          source?.entry &&
          source.candidate &&
          bar[trigger] < source.candidate.high
        )
          pivotFailures.push({
            breakoutDate: source.date,
            confirmationDate: point.date,
            pivot: source.candidate.high,
            value: bar[trigger],
            day,
            trigger,
          });
      }
    return { ...point, exit: pivotFailures.length > 0, pivotFailures };
  });
}
