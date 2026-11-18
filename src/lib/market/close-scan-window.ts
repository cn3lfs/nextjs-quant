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

export type CloseScanPhase =
  | "unknown-date"
  | "waiting"
  | "unconfirmed"
  | "running"
  | "missed"
  | "complete";

/** The persisted close record proves the phase ended, never that inputs or the
 * whole market were complete; waiting and unconfirmed stay separate. */
export function closeScanPhase(
  date: string | null,
  record: { status?: string } | undefined,
  now: number,
  calendar: readonly string[],
): { phase: CloseScanPhase; calendarConfirmed: boolean } {
  if (!date) return { phase: "unknown-date", calendarConfirmed: false };
  const window = closeScanWindow(date, calendar);
  const calendarConfirmed =
    calendar.length > 0 && calendar.includes(date) && window.calendarConfirmed;
  if (record?.status === "complete")
    return { phase: "complete", calendarConfirmed };
  if (record?.status === "running")
    return { phase: "running", calendarConfirmed };
  if (record?.status === "missed")
    return { phase: "missed", calendarConfirmed };
  if (!calendar.length) return { phase: "unconfirmed", calendarConfirmed };
  if (now < window.completedAt) return { phase: "waiting", calendarConfirmed };
  // Missed only when the next trading day is confirmed; a weekday fallback is
  // not evidence that the deadline passed.
  if (window.calendarConfirmed && now >= window.deadline)
    return { phase: "missed", calendarConfirmed };
  return { phase: "unconfirmed", calendarConfirmed };
}
