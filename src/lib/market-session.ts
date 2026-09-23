/**
 * Shanghai/Shenzhen session clock for display only. Trading-day status comes
 * from the scheduler's calendar check when available; without it, weekends are
 * the only days known to be closed.
 */
export type SessionKind =
  | "closed-day"
  | "pre-open"
  | "auction"
  | "morning"
  | "lunch"
  | "afternoon"
  | "closed";

const labels: Record<SessionKind, string> = {
  "closed-day": "非交易日",
  "pre-open": "盘前",
  auction: "集合竞价",
  morning: "上午盘",
  lunch: "午间休市",
  afternoon: "下午盘",
  closed: "已收盘",
};

/** Beijing wall-clock parts of an epoch timestamp. */
export function beijingClock(now: number) {
  const local = new Date(now + 8 * 3600000);
  const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
  return {
    date: local.toISOString().slice(0, 10),
    weekday: local.getUTCDay(),
    minutes,
    hhmm: formatMinutes(minutes),
  };
}

export function formatMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function parseHhmm(value: string) {
  const [h, m] = value.split(":").map(Number);
  return h! * 60 + m!;
}

export function marketSession(
  now: number,
  trading: "open" | "closed" | "unknown" = "unknown",
) {
  const clock = beijingClock(now);
  const weekend = clock.weekday === 0 || clock.weekday === 6;
  const m = clock.minutes;
  const kind: SessionKind =
    trading === "closed" || (trading === "unknown" && weekend)
      ? "closed-day"
      : m < 9 * 60 + 15
        ? "pre-open"
        : m < 9 * 60 + 30
          ? "auction"
          : m < 11 * 60 + 30
            ? "morning"
            : m < 13 * 60
              ? "lunch"
              : m < 15 * 60
                ? "afternoon"
                : "closed";
  return { ...clock, kind, label: labels[kind] };
}

export type DayPhase = "盘前" | "午盘前" | "尾盘前" | "收盘后";

/**
 * Overview phase: which scheduled window comes next. A window stays current
 * through its five-minute launch window, matching `intradaySchedule`.
 */
export function dayPhase(
  minutes: number,
  cutoffs: { noon: string; late: string },
): DayPhase {
  if (minutes < 9 * 60 + 30) return "盘前";
  if (minutes < parseHhmm(cutoffs.noon) + 5) return "午盘前";
  if (minutes < parseHhmm(cutoffs.late) + 5) return "尾盘前";
  return "收盘后";
}

const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
export function dateLine(now: number) {
  const clock = beijingClock(now);
  return `${clock.date} ${weekdays[clock.weekday]}`;
}
