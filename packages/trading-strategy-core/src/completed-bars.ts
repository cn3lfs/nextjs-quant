import type { Period } from "./bars.js";

export function completedBar(date: string, period: Period, now: number) {
  return completedBarFilter(period, now)(date);
}

/** Freeze one A-share evaluation cutoff. Continuous markets use their UTC
 * candle completion metadata rather than the Shanghai daily close. */
export function completedBarFilter(period: Period, now: number) {
  const local = new Date(now + 8 * 3600000).toISOString(),
    today = local.slice(0, 10),
    closed = local.slice(11, 16) >= "15:05";
  return (date: string) => {
    if (date.slice(0, 10) > today) return false;
    if (period === "day") return date < today || closed;
    if (period === "week") {
      const end = new Date(`${date.slice(0, 10)}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + ((5 - end.getUTCDay() + 7) % 7));
      return (
        Date.parse(`${end.toISOString().slice(0, 10)}T15:05:00+08:00`) <= now
      );
    }
    return Date.parse(date) <= now;
  };
}
