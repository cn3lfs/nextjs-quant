import type Database from "better-sqlite3";
import { settingsSchema } from "~/lib/domain";
import { beijingClock } from "~/lib/market/market-session";
import {
  gfCalendarReference,
  parseGfCalendar,
} from "../data-sources/gf/gf-calendar";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import type { DeploymentRecord } from "../db/deployment-repository";
import {
  localCalendarReference,
  type CalendarReference,
} from "../market/data-health";

export const fallbackWarning =
  "交易日历缺失，暂按下一工作日规划，执行日期待确认";

type SessionReader = (date: string) => boolean | null | Promise<boolean | null>;

const observedSessions = new WeakMap<
  Database.Database,
  Map<string, { open: boolean; expires: number }>
>();

/** Synchronous settlement reads the same validated month or session that the
 * scheduler observed. It must never wait on a network call in a write transaction. */
export function knownCnSession(
  db: Database.Database,
  date: string,
): boolean | null {
  const recent = observedSessions.get(db)?.get(date);
  if (recent && recent.expires > Date.now()) return recent.open;
  const month = date.slice(0, 7);
  const cached = new AccountWorkspaceRepository(db).record<{ raw: unknown }>(
    `gf-calendar-1-${month}`,
  );
  if (cached) {
    try {
      const official = parseGfCalendar(cached.raw, month);
      if (official.days.includes(date)) return true;
      if (official.closedDays?.includes(date)) return false;
    } catch {
      /* No verified evidence in this record. */
    }
  }
  return null;
}

export function cnExecutionWindow(
  deployment: DeploymentRecord,
  date: string,
  ms: number,
) {
  const { schedule } = deployment;
  const current = beijingClock(ms);
  return (
    schedule.kind === "post_close_auto" &&
    schedule.executeAtOpen &&
    current.date === date &&
    current.hhmm >= schedule.openStartTime &&
    current.hhmm <= schedule.openCutoffTime
  );
}

/** One lookup per month per planning request/tick. Unknown weekdays permit provisional plans only. */
export function cnTradingCalendar(
  db: Database.Database,
  today = beijingClock(Date.now()).date,
  readSession?: SessionReader,
) {
  const repo = new AccountWorkspaceRepository(db);
  const { tdxRoot, calendar } = settingsSchema.parse(
    repo.record("settings") ?? {},
  );
  const months = new Map<string, Promise<CalendarReference | null>>();
  const sessions = new Map<string, Promise<boolean | null>>();
  let history: Promise<CalendarReference> | undefined;
  async function loadMonth(date: string) {
    const month = date.slice(0, 7);
    try {
      const now = Date.now();
      return await gfCalendarReference(
        beijingClock(now).date.startsWith(month) ? now : Date.parse(date),
      );
    } catch {
      const cached = repo.record<{ raw: unknown }>(`gf-calendar-1-${month}`);
      if (cached) {
        try {
          return parseGfCalendar(cached.raw, month);
        } catch {
          /* Invalid cache supplies no evidence. */
        }
      }
      return null;
    }
  }
  async function lookup(date: string): Promise<boolean | null> {
    const month = date.slice(0, 7);
    if (!months.has(month)) months.set(month, loadMonth(date));
    const official = await months.get(month);
    if (official?.days.includes(date)) return true;
    if (official?.closedDays?.includes(date)) return false;
    const within = (days: string[]) =>
      days.some((d) => d <= date) && days.some((d) => d >= date);
    if (within(calendar)) return calendar.includes(date);
    if (date < today) {
      history ??= localCalendarReference(tdxRoot, []);
      const { days } = await history;
      if (within(days)) return days.includes(date);
    }
    return null;
  }
  async function session(date: string) {
    let evidence = sessions.get(date);
    if (!evidence) {
      evidence = Promise.resolve((readSession ?? lookup)(date));
      sessions.set(date, evidence);
    }
    const open = await evidence;
    if (open !== null) {
      let observed = observedSessions.get(db);
      if (!observed) observedSessions.set(db, (observed = new Map()));
      observed.set(date, { open, expires: Date.now() + 60_000 });
    }
    return open;
  }
  async function nextSession(date: string) {
    let ms = Date.parse(date) + 86400000;
    for (let dayOffset = 0; dayOffset < 370; dayOffset++, ms += 86400000) {
      const day = new Date(ms);
      const executeDate = day.toISOString().slice(0, 10);
      const confirmed = await session(executeDate);
      if (confirmed) return { executeDate, calendarWarning: null };
      if (confirmed === null && day.getUTCDay() > 0 && day.getUTCDay() < 6)
        return { executeDate, calendarWarning: fallbackWarning };
    }
    throw new Error("交易日历未提供可规划的下一交易日");
  }
  /**
   * First session confirmed open with every intervening day confirmed closed.
   * An unknown day stops the scan: skipping it could silently move an intent
   * across a possible session. Provisional planning still uses nextSession.
   */
  async function nextConfirmedSession(date: string) {
    let ms = Date.parse(date) + 86400000;
    for (let day = 0; day < 370; day++, ms += 86400000) {
      const executeDate = new Date(ms).toISOString().slice(0, 10);
      const confirmed = await session(executeDate);
      if (confirmed) return executeDate;
      if (confirmed === null) return null;
    }
    return null;
  }
  return { session, nextSession, nextConfirmedSession };
}
