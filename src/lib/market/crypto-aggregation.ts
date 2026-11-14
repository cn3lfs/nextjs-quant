import type { Bar } from "../domain";
import type { ChartPeriod } from "../chart/chart-view";

const dayMs = 86400000;
export const cryptoPeriodMs: Partial<Record<ChartPeriod, number>> = {
  "5m": 300000,
  "15m": 900000,
  "30m": 1800000,
  "60m": 3600000,
  "1h": 3600000,
  "4h": 14400000,
  day: dayMs,
  week: 7 * dayMs,
};
export function cryptoPeriodEnd(date: string, period: ChartPeriod) {
  if (/^\d+[mh]$/.test(period)) return Date.parse(date);
  const start = Date.parse(date);
  if (period === "month") {
    const d = new Date(start);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return start + cryptoPeriodMs[period]!;
}
/** Continuous UTC candles, end labelled intraday and open labelled daily.
 * Missing components invalidate a bucket; a forming bucket needs a full prefix. */
export function aggregateCryptoBars(
  bars: Bar[],
  base: "day" | "5m" | "15m" | "1h",
  target: ChartPeriod,
  now: number,
  sourceForming: readonly string[] = [],
) {
  const groups = new Map<number, { bars: Bar[]; start: number; end: number }>();
  const step = cryptoPeriodMs[base]!;
  let previous = -Infinity;
  for (const bar of bars) {
    const time = Date.parse(bar.date);
    const start = base === "day" ? time : time - step;
    if (
      !Number.isFinite(time) ||
      start <= previous ||
      start % step ||
      ![bar.open, bar.high, bar.low, bar.close].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      bar.high < Math.max(bar.open, bar.close) ||
      bar.low > Math.min(bar.open, bar.close) ||
      ![bar.volume, bar.amount].every((v) => Number.isFinite(v) && v >= 0)
    )
      throw new Error("数字货币聚合源行情无效");
    previous = start;
    let opening: number, end: number;
    if (target === "month") {
      const d = new Date(start);
      opening = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
      end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    } else if (target === "week") {
      const d = new Date(start);
      opening =
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
        ((d.getUTCDay() + 6) % 7) * dayMs;
      end = opening + 7 * dayMs;
    } else {
      const size = cryptoPeriodMs[target];
      if (!size || size < step || size % step)
        throw new Error("聚合周期与基础周期不匹配");
      opening = Math.floor(start / size) * size;
      end = opening + size;
    }
    const group = groups.get(opening) ?? { bars: [], start: opening, end };
    group.bars.push(bar);
    groups.set(opening, group);
  }
  const result: Bar[] = [],
    formingDates: string[] = [],
    excluded: { date: string; reason: string }[] = [];
  for (const { bars: rows, start, end } of groups.values()) {
    const date =
      target === "day" || target === "week" || target === "month"
        ? new Date(start).toISOString().slice(0, 10)
        : new Date(end).toISOString().replace(".000Z", "+00:00");
    const expected = Math.min(
      (end - start) / step,
      Math.max(1, Math.ceil((now - start) / step)),
    );
    const complete =
      rows.length === expected &&
      rows.every(
        (bar, i) =>
          Date.parse(bar.date) - (base === "day" ? 0 : step) ===
          start + i * step,
      );
    if (!complete) {
      excluded.push({ date, reason: "缺少组成周期行情" });
      continue;
    }
    result.push({
      date,
      open: rows[0]!.open,
      close: rows.at(-1)!.close,
      high: Math.max(...rows.map((b) => b.high)),
      low: Math.min(...rows.map((b) => b.low)),
      volume: rows.reduce((n, b) => n + b.volume, 0),
      amount: rows.reduce((n, b) => n + b.amount, 0),
    });
    if (end > now || rows.some((b) => sourceForming.includes(b.date)))
      formingDates.push(date);
  }
  return { bars: result, formingDates, excluded };
}
