import { beijingClock } from "./market-session";

/** Only the latest completed trading date is eligible; never replay a backlog. */
export function closeScanDate(now: number, calendar: readonly string[]) {
  const wall = beijingClock(now);
  return (
    [...new Set(calendar)]
      .sort()
      .filter(
        (date) =>
          date < wall.date || (date === wall.date && wall.minutes >= 900),
      )
      .at(-1) ?? null
  );
}

export function closeScanWindow(date: string, calendar: readonly string[]) {
  let next = [...new Set(calendar)].sort().find((day) => day > date);
  const calendarConfirmed = next !== undefined;
  if (!next) {
    // Local index files contain historical dates only. Do not block tonight's
    // scan waiting for a future bar, or guess a holiday extension for delivery.
    const day = new Date(`${date}T00:00:00Z`);
    do day.setUTCDate(day.getUTCDate() + 1);
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6);
    next = day.toISOString().slice(0, 10);
  }
  return {
    completedAt: Date.parse(`${date}T15:00:00+08:00`),
    deadline: Date.parse(`${next}T09:00:00+08:00`),
    calendarConfirmed,
  };
}

export function closeScanDeadline(date: string, calendar: readonly string[]) {
  return closeScanWindow(date, calendar).deadline;
}

export function closeScanOpen(
  date: string,
  now: number,
  calendar: readonly string[],
) {
  const window = closeScanWindow(date, calendar);
  return now >= window.completedAt && now < window.deadline;
}
