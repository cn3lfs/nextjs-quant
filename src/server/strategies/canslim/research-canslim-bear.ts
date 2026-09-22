import type { Bar } from "~/lib/domain";
import { maSeries } from "~/lib/indicators";
import type { researchCanslimPriorityPoint } from "./research-canslim-priority";

/** Daily-close experiment: the source leaves the volume comparator undefined. */
export function researchCanslimBear(
  points: readonly ReturnType<typeof researchCanslimPriorityPoint>[],
  bars: readonly Bar[],
  calendar: readonly string[],
  basis: "previous" | "ma20",
) {
  const dates = new Map(calendar.map((date, index) => [date, index]));
  const volumes = maSeries(
    bars.map((bar) =>
      Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : null,
    ),
    20,
  );
  const valid = (bar: Bar | undefined) =>
    !!bar &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close);
  return points.map((point, index) => {
    const bar = bars[index];
    const previous = bars[index - 1];
    const size = basis === "ma20" ? 20 : 1;
    const dateIndex = dates.get(point.date);
    const complete =
      dateIndex != null &&
      index >= size &&
      bars
        .slice(index - size, index + 1)
        .every(
          (item, offset) => item.date === calendar[dateIndex - size + offset],
        );
    const reference = basis === "ma20" ? volumes[index - 1] : previous?.volume;
    const available =
      bar?.date === point.date &&
      valid(bar) &&
      valid(previous) &&
      complete &&
      reference != null &&
      Number.isFinite(reference) &&
      reference > 0;
    const expanded =
      available &&
      (basis === "ma20"
        ? bar!.volume >= reference! * 1.5
        : bar!.volume > reference!);
    // Compare prices directly so exactly -4% does not trigger due to division rounding.
    const triggered = !!(
      available &&
      bar!.close < previous!.close * 0.96 &&
      expanded
    );
    return {
      ...point,
      exit: triggered,
      bearExit: {
        basis,
        date: point.date,
        previousDate: previous?.date ?? null,
        previousClose: available ? previous!.close : null,
        close: available ? bar!.close : null,
        volume: available ? bar!.volume : null,
        referenceVolume: available ? reference! : null,
        threshold: basis === "ma20" ? 1.5 : 1,
        triggered,
        reason: available ? null : "退出所需连续价格或量能窗口不可用",
      },
    };
  });
}
