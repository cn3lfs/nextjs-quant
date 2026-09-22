import type { Period } from "./domain";
export function completedBar(date: string, period: Period, now: number) {
  return completedBarFilter(period, now)(date);
}
/** Freeze one evaluation cutoff for every bar in the same calculation. */
export function completedBarFilter(period: Period, now: number) {
  const local = new Date(now + 8 * 3600000).toISOString(),
    today = local.slice(0, 10),
    closed = local.slice(11, 16) >= "15:05";
  return (date: string) => {
    if (date.slice(0, 10) > today) return false;
    if (period === "day") return date < today || closed;
    return Date.parse(date) <= now;
  };
}
