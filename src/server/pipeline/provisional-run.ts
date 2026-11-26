import type Database from "better-sqlite3";
import {
  getPipelineRun,
  type PipelineRunRecord,
} from "../db/pipeline-repository";
import {
  expireOverdueIntents,
  hasRolloverToExecuteDate,
  isProvisionalExecuteDate,
  listPendingRunIds,
  listPendingRunIdsByDate,
  reschedulePendingPipelineRun,
} from "../db/provisional-run-repository";
import type { DeploymentRecord } from "../db/deployment-repository";
import { beijingClock } from "~/lib/market/market-session";
import { cnTradingCalendar } from "./cn-trading-calendar";

export {
  expireOverdueIntents,
  isProvisionalExecuteDate,
  listPendingRunIds,
  listPendingRunIdsByDate,
  reschedulePendingPipelineRun,
};

export type ExecutionCalendar = Pick<
  ReturnType<typeof cnTradingCalendar>,
  "session" | "nextConfirmedSession"
>;

/** Check the date before quoting or claiming an intent. A provisional date
 * carries no execution authority until the calendar confirms the session. */
export async function settlePendingRunDate(
  run: PipelineRunRecord,
  deployment: DeploymentRecord,
  db: Database.Database,
  clock = Date.now,
  calendar?: ExecutionCalendar,
  expireScheduled = false,
) {
  const result = {
    executeDate: run.executeDate,
    reason: null as string | null,
    rolledOverRuns: 0,
    expiredIntents: 0,
  };
  if (deployment.market !== "cn-equity") return result;
  const provisional = isProvisionalExecuteDate(run, db);
  const rolledForward = !provisional && hasRolloverToExecuteDate(run, db);
  const dates = () =>
    (calendar ??= cnTradingCalendar(db, beijingClock(clock()).date));
  const session =
    provisional || rolledForward
      ? await dates().session(run.executeDate)
      : true;
  const next =
    provisional && session === false
      ? await dates().nextConfirmedSession(run.executeDate)
      : null;
  const { date: today, hhmm } = beijingClock(clock());
  const { schedule } = deployment;
  const opening = schedule.kind === "post_close_auto" && schedule.executeAtOpen;
  if (
    next &&
    (next > today ||
      (next === today && (!opening || hhmm <= schedule.openCutoffTime)))
  ) {
    const moved = reschedulePendingPipelineRun(run, next, db);
    if (moved) {
      result.executeDate = next;
      result.rolledOverRuns = 1;
      result.reason = next > today ? "future-execute-date" : null;
      return result;
    }
    // Another caller may already have settled this run. A stale approval
    // must not claim the original date or implicitly change the user's order.
    if (getPipelineRun(run.id, db)?.executeDate !== run.executeDate) {
      result.reason = "execute-date-mismatch";
      return result;
    }
  }
  if (run.executeDate > today) result.reason = "future-execute-date";
  else if (
    run.executeDate < today &&
    ((expireScheduled && opening) || provisional || rolledForward)
  ) {
    // Keep waiting through a holiday outage until there is evidence of a
    // session that the scheduler actually missed.
    if (session !== true && !next && (await dates().session(today)) !== true)
      result.reason = "execution-calendar-unconfirmed";
    else {
      result.expiredIntents = expireOverdueIntents(run, db);
      result.reason = "execute-date-expired";
    }
  } else if (session !== true) {
    result.reason =
      session === false
        ? "execution-calendar-closed"
        : "execution-calendar-unconfirmed";
  }
  return result;
}
