import {
  intradayConfigSchema,
  intradaySchedule,
} from "~/lib/strategy-facts/intraday-schedule";
import { get, put, sqlite } from "../db";
import { settings } from "../infra/settings";
import { monitorCalendar } from "./monitor-calendar";
import { intradayPool, intradayHistory } from "./intraday-data";
import { IntradayJob } from "./intraday-job";
import { IntradayStore } from "./intraday-store";
import type { IntradayDependencies } from "./intraday-job";

export function intradayConfig() {
  return intradayConfigSchema.parse(get("intraday-config") ?? {});
}
export type IntradayCheck = {
  checkedAt: number;
  calendarSource: string;
  schedule: ReturnType<typeof intradaySchedule>;
};
export function intradayLastCheck() {
  return get<IntradayCheck>("intraday-check") ?? null;
}
export function saveIntradayConfig(input: unknown) {
  return put(
    "intraday-config",
    "intraday-config",
    intradayConfigSchema.parse(input),
  );
}
export function intradayDependencies(
  czsc: IntradayDependencies["czsc"],
): IntradayDependencies {
  return {
    now: Date.now,
    calendar: async () => {
      const config = settings();
      return monitorCalendar(
        config.tdxRoot,
        config.calendar,
        false,
        true,
        Date.now(),
      );
    },
    pool: intradayPool,
    history: intradayHistory,
    czsc,
  };
}

/** Called inside the task worker; native projections are supplied by the host.
 * No subscription or delivery API is involved in preselection.
 */
export async function runIntradayTick(deps: IntradayDependencies) {
  const config = intradayConfig();
  if (!config.enabled) return;
  const store = new IntradayStore(sqlite());
  const job = new IntradayJob(store, deps);
  const calendar = await deps.calendar();
  const checkedAt = deps.now();
  const schedule = intradaySchedule(config, checkedAt, calendar);
  put("intraday-check", "intraday-check", {
    checkedAt,
    calendarSource: calendar.source,
    schedule,
  } satisfies IntradayCheck);
  for (const slot of schedule.slots) {
    if (slot.status === "due" || slot.status === "missed")
      await job.preview(config, slot.slot);
  }
  if (!schedule.closeDue) return;
  // Keyset over pending observations so old missing inputs do not starve newer
  // dates. A close retry is throttled to fifteen minutes per observation.
  const rows = store.db
    .prepare(
      `SELECT p.id FROM records p WHERE p.kind='intraday-preview'
    AND json_extract(p.payload,'$.barCutoff') <= ?
    AND NOT EXISTS (SELECT 1 FROM records c WHERE c.kind='intraday-close'
      AND json_extract(c.payload,'$.observationId')=p.id
      AND (json_type(c.payload,'$.close.signalKeys')='array' OR c.updated_at>?))
    ORDER BY p.updated_at DESC,p.id`,
    )
    .all(`${schedule.date}T15:00:00+08:00`, deps.now() - 15 * 60000) as {
    id: string;
  }[];
  for (const row of rows) await job.confirm(row.id);
}
