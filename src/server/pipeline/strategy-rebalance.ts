import type Database from "better-sqlite3";
import { readLocalTradingDates } from "tstdx/local";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { settingsSchema } from "~/lib/domain";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { parseGfCalendar } from "../data-sources/gf/gf-calendar";

export type RebalanceCadence = "daily" | "weekly" | "month-end" | "quarter-end";
export type StrategySkipReason = "non-rebalance-day" | "missing-data";
export type ReadTradingSessions = (
  decisionDate: string,
) => readonly string[] | Promise<readonly string[]>;

export class MissingStrategyData extends Error {}

export function strategySettings(db?: Database.Database) {
  return settingsSchema.parse(
    new AccountWorkspaceRepository(db).record("settings") ?? {},
  );
}

export async function localMarketSessions(
  date: string,
  db?: Database.Database,
) {
  const workspace = new AccountWorkspaceRepository(db);
  const { tdxRoot, calendar } = strategySettings(db);
  const local = await readLocalTradingDates(tdxRoot).catch(() => null);
  const sessions = new Set([...calendar, ...(local?.days ?? [])]);
  // The cached official calendar can cover a holiday boundary before the next
  // session has a local index bar. Dates are the only forward facts used.
  const nextMonth = new Date(date + "T00:00:00Z");
  nextMonth.setUTCDate(1);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  for (const month of [date.slice(0, 7), nextMonth.toISOString().slice(0, 7)]) {
    const record = workspace.record<{ raw: unknown }>(`gf-calendar-1-${month}`);
    if (!record) continue;
    const official = parseGfCalendar(record.raw, month);
    for (const closed of official.closedDays ?? []) sessions.delete(closed);
    for (const session of official.days) sessions.add(session);
    // parseGfCalendar validates the last day's link even across month boundaries.
    const { data } = record.raw as { data: { nxtTrdDay: number }[] };
    const next = String(data.at(-1)!.nxtTrdDay);
    sessions.add(`${next.slice(0, 4)}-${next.slice(4, 6)}-${next.slice(6)}`);
  }
  return [...sessions].sort();
}

export function validatedSessions(sessions: readonly string[]) {
  if (
    sessions.some(
      (date, i) =>
        !researchDateSchema.safeParse(date).success ||
        (i > 0 && date <= sessions[i - 1]!),
    )
  )
    throw new MissingStrategyData("市场交易日历无效、无序或重复");
  return sessions;
}

function periodKey(date: string, cadence: Exclude<RebalanceCadence, "daily">) {
  if (cadence === "month-end") return date.slice(0, 7);
  if (cadence === "quarter-end")
    return `${date.slice(0, 4)}-${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
  const monday = new Date(date + "T00:00:00Z");
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

/** The epoch is the first covered session of the frozen Alpha experiment. */
export function rebalanceSkip(
  date: string,
  sessions: readonly string[],
  cadence: RebalanceCadence | { every: number; epoch: string },
): StrategySkipReason | undefined {
  const index = sessions.indexOf(date);
  if (index < 0)
    return sessions[0]! < date && date < sessions.at(-1)!
      ? "non-rebalance-day"
      : "missing-data";
  if (typeof cadence !== "string") {
    const epoch = sessions.indexOf(cadence.epoch);
    if (date < cadence.epoch) return "non-rebalance-day";
    if (epoch < 0) return "missing-data";
    return (index - epoch) % cadence.every ? "non-rebalance-day" : undefined;
  }
  if (cadence === "daily") return;
  const next = sessions[index + 1];
  if (!next) return "missing-data";
  if (periodKey(date, cadence) === periodKey(next, cadence))
    return "non-rebalance-day";
}
