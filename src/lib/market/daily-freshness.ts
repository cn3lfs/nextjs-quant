/**
 * The day local daily bars should reach at `now`: today after 15:05 on a known
 * trading day, otherwise the last trading day before today. Null when the
 * calendar cannot say.
 */
export function expectedDailyAsOf(
  calendar: { days: readonly string[] },
  now: number,
): string | null {
  const local = new Date(now + 8 * 3600000).toISOString();
  const today = local.slice(0, 10),
    minutes = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
  const days = [...new Set(calendar.days)].sort();
  if (days.includes(today) && minutes >= 905) return today;
  return days.filter((day) => day < today).at(-1) ?? null;
}
