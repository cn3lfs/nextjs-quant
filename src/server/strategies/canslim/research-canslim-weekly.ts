import type { Bar } from "~/lib/domain";
import { maSeries } from "trading-strategy-core/indicators";
import { isoWeek } from "~/lib/backtest/period-performance";

type Week = { key: string; dates: string[]; completedAt: string };
/** Friday closes are complete. Holiday short weeks become known on the next
 * observed week, never by looking ahead at a future stock close. */
export function researchCanslimWeekly<T extends { date: string }>(
  points: readonly T[],
  bars: readonly Bar[],
  calendar: readonly string[],
) {
  const groups = new Map<string, Week>();
  for (const date of calendar) {
    const day = new Date(date).getUTCDay();
    if (day < 1 || day > 5) continue;
    const key = isoWeek(date).join("-W");
    let week = groups.get(key);
    if (!week) {
      week = {
        key,
        dates: [],
        completedAt: new Date(Date.parse(date) + (5 - day) * 86400000)
          .toISOString()
          .slice(0, 10),
      };
      groups.set(key, week);
    }
    week.dates.push(date);
  }
  const weeks = [...groups.values()];
  const byDate = new Map(bars.map((bar) => [bar.date, bar]));
  const closes: (number | null)[] = [];
  const completed: { week: string; closeDate: string; close: number | null }[] =
    [];
  let next = 0;
  let previousAverage: number | null = null;
  const below = (price: number, line: number) =>
    line - price > Math.max(price, line) * Number.EPSILON * 8;
  return points.map((point) => {
    let weeklyReduction: {
      week: string;
      completedAt: string;
      confirmedDate: string;
      closeDate: string;
      close: number | null;
      average: number | null;
      previousClose: number | null;
      previousAverage: number | null;
      triggered: boolean;
      fraction: number;
      window: typeof completed;
      reason: string | null;
    } | null = null;
    while (weeks[next] && weeks[next]!.completedAt <= point.date) {
      const week = weeks[next]!;
      const complete =
        (next > 0 || new Date(week.dates[0]!).getUTCDay() === 1) &&
        week.dates.every((date) => {
          const bar = byDate.get(date);
          return (
            bar &&
            [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
              (value) => Number.isFinite(value) && value > 0,
            ) &&
            bar.high >= Math.max(bar.open, bar.close, bar.low) &&
            bar.low <= Math.min(bar.open, bar.close)
          );
        });
      const closeDate = week.dates.at(-1)!;
      const close = complete ? byDate.get(closeDate)!.close : null;
      const previousClose = closes.at(-1) ?? null;
      const previousLine = previousAverage;
      closes.push(close);
      completed.push({ week: week.key, closeDate, close });
      const average = maSeries(closes, 10).at(-1) ?? null;
      const ready =
        close != null &&
        average != null &&
        previousClose != null &&
        previousLine != null;
      weeklyReduction = {
        week: week.key,
        completedAt: week.completedAt,
        confirmedDate: point.date,
        closeDate,
        close,
        average,
        previousClose,
        previousAverage: previousLine,
        triggered:
          ready && !below(previousClose, previousLine) && below(close, average),
        fraction: 0.5,
        window: completed.slice(-10),
        reason: ready ? null : "缺少连续有效已完成周线及前一周10周均线",
      };
      previousAverage = average;
      next++;
    }
    return { ...point, weeklyReduction };
  });
}
