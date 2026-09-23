import type { Bar } from "~/lib/domain";
import { maSeries } from "trading-strategy-core/indicators";

/** Entry-table S1, deliberately independent of the reference's tiered score. */
export function researchCanslimVolumeScore(
  bars: readonly Bar[],
  calendar: readonly string[] = bars.map((bar) => bar.date),
) {
  const dates = new Map(calendar.map((date, index) => [date, index]));
  const means = maSeries(
    bars.map((bar) => bar.volume),
    20,
  );
  let previousPoints: number | null = null;
  return bars.map((bar, index) => {
    const dateIndex = dates.get(bar.date);
    const window = bars.slice(Math.max(0, index - 24), index + 1);
    const valid =
      window.length === 25 &&
      dateIndex != null &&
      window.every(
        (item, offset) =>
          item.date === calendar[dateIndex - 24 + offset] &&
          [item.open, item.high, item.low, item.close, item.volume].every(
            (value) => Number.isFinite(value) && value > 0,
          ) &&
          item.high >= Math.max(item.open, item.close, item.low) &&
          item.low <= Math.min(item.open, item.close),
      );
    const mean20 = valid ? (means[index - 5] ?? null) : null;
    const peak5 = valid
      ? Math.max(...window.slice(-5).map((item) => item.volume))
      : null;
    const available =
      mean20 !== null &&
      Number.isFinite(mean20) &&
      mean20 > 0 &&
      peak5 !== null;
    const points = available ? (peak5 >= mean20 * 1.5 ? 8 : 0) : null;
    const result = {
      date: bar.date,
      entry: previousPoints === 0 && points === 8,
      exit: false,
      reason:
        points === null
          ? "缺少连续25个研究交易日的有效OHLCV"
          : previousPoints === null
            ? "前一观察评分未知，不确认上穿"
            : null,
      values: { close: Number.isFinite(bar.close) ? bar.close : null },
      diagnostic: {
        version: "canslim-volume-entry-binary-1",
        status: points === null ? "missing" : "computed",
        points,
        maxPoints: 8,
        mean20,
        peak5,
        previousPoints,
      },
    };
    previousPoints = points;
    return result;
  });
}
