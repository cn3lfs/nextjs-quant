import type Database from "better-sqlite3";
import {
  buildIntentIdempotencyKey,
  isTerminalIntentStatus,
} from "trading-strategies";
import { researchDateSchema as dateSchema } from "trading-strategies/research/contracts/date";
import {
  appendExecutionAuditEvent,
  getPipelineRun,
  listIntentsByRun,
  transitionIntentStatus,
  updatePipelineRunStage,
  type OrderIntentRecord,
  type PipelineRunRecord,
} from "./pipeline-repository";
import { sqlite } from "./index";

const pendingIntentStatuses = ["planned", "queued"] as const;
const pendingIntentSql = pendingIntentStatuses.map(() => "?").join(",");
const legacyDecisionDateWarning =
  "决策日交易日历缺失，暂按工作日和收盘数据回执规划";
const pendingIntent = ({ status }: OrderIntentRecord) =>
  pendingIntentStatuses.some((pending) => pending === status);

/** Runs still holding an unclaimed intent. Ordered so a tick plans the same way every time. */
export function listPendingRunIds(
  deploymentId: string,
  connection: Database.Database = sqlite(),
) {
  return connection
    .prepare<[string, ...string[]], { runId: string }>(
      `SELECT DISTINCT run_id AS runId FROM execution_order_intents
       WHERE deployment_id=? AND status IN (${pendingIntentSql}) ORDER BY run_id`,
    )
    .all(deploymentId, ...pendingIntentStatuses)
    .map(({ runId }) => runId);
}

export function listPendingRunIdsByDate(
  deploymentId: string,
  executeDate: string,
  connection: Database.Database = sqlite(),
) {
  return connection
    .prepare<[string, string, ...string[]], { runId: string }>(
      `SELECT DISTINCT run_id AS runId FROM execution_order_intents
       WHERE deployment_id=? AND execute_date=? AND status IN (${pendingIntentSql})
       ORDER BY run_id`,
    )
    .all(deploymentId, dateSchema.parse(executeDate), ...pendingIntentStatuses)
    .map(({ runId }) => runId);
}

export function isProvisionalExecuteDate(
  run: { id: string; executeDate: string },
  connection: Database.Database = sqlite(),
) {
  return (
    connection
      .prepare(
        `SELECT 1 FROM execution_audit_events
         WHERE run_id=? AND event_type='execution_calendar_fallback'
           AND json_extract(details_json,'$.executeDate')=?
           AND json_extract(details_json,'$.warning') IS NOT ? LIMIT 1`,
      )
      .get(run.id, run.executeDate, legacyDecisionDateWarning) !== undefined
  );
}

export function hasRolloverToExecuteDate(
  run: { id: string; executeDate: string },
  connection: Database.Database = sqlite(),
) {
  return (
    connection
      .prepare(
        `SELECT 1 FROM execution_audit_events WHERE run_id=? AND event_type='execution_calendar_rollover'
         AND json_extract(details_json,'$.to')=? LIMIT 1`,
      )
      .get(run.id, run.executeDate) !== undefined
  );
}

/**
 * Move a wholly unclaimed run to a later confirmed session. Dates, intent
 * idempotency keys and the rollover audit change together, and an existing
 * from/to audit makes retries no-ops.
 */
export function reschedulePendingPipelineRun(
  previous: { id: string; executeDate: string },
  rawExecuteDate: string,
  connection: Database.Database = sqlite(),
) {
  const executeDate = dateSchema.parse(rawExecuteDate);
  return connection
    .transaction(() => {
      const run = getPipelineRun(previous.id, connection);
      if (
        !run ||
        run.executeDate !== previous.executeDate ||
        executeDate <= run.executeDate ||
        !isProvisionalExecuteDate(run, connection)
      )
        return null;
      const intents = listIntentsByRun(run.id, connection);
      if (!intents.length || !intents.every(pendingIntent)) return null;
      const duplicate = connection
        .prepare(
          `SELECT 1 FROM execution_audit_events WHERE run_id=? AND event_type='execution_calendar_rollover'
           AND json_extract(details_json,'$.from')=? AND json_extract(details_json,'$.to')=? LIMIT 1`,
        )
        .get(run.id, run.executeDate, executeDate);
      if (duplicate) return null;
      const updated = connection
        .prepare(
          "UPDATE pipeline_runs SET execute_date=? WHERE id=? AND execute_date=? RETURNING id",
        )
        .get(executeDate, run.id, run.executeDate);
      if (!updated) return null;
      const updateIntent = connection.prepare(
        "UPDATE execution_order_intents SET execute_date=?,idempotency_key=? WHERE id=?",
      );
      for (const intent of intents)
        updateIntent.run(
          executeDate,
          buildIntentIdempotencyKey({
            deploymentId: run.deploymentId,
            decisionDate: run.decisionDate,
            executeDate,
            symbol: intent.symbol,
            side: intent.side,
            phase: String(intent.phase),
            runSlot: run.runSlot,
          }),
          intent.id,
        );
      appendExecutionAuditEvent(
        {
          deploymentId: run.deploymentId,
          runId: run.id,
          eventType: "execution_calendar_rollover",
          details: {
            from: run.executeDate,
            to: executeDate,
            intents: intents.length,
            reason: "provisional-date-confirmed-closed",
          },
        },
        connection,
      );
      return {
        from: run.executeDate,
        to: executeDate,
        intents: intents.length,
      };
    })
    .immediate();
}

/** Reject overdue unclaimed intents while preserving submitted order evidence. */
export function expireOverdueIntents(
  run: Pick<PipelineRunRecord, "id" | "executeDate">,
  db: Database.Database,
) {
  return db
    .transaction(() => {
      const current = getPipelineRun(run.id, db);
      if (current?.executeDate !== run.executeDate) return 0;
      const intents = listIntentsByRun(run.id, db);
      const pending = intents.filter(pendingIntent);
      if (!pending.length) return 0;
      for (const intent of pending)
        transitionIntentStatus(
          intent.id,
          "rejected",
          { errorSummary: "execute-date-expired" },
          db,
        );
      const remaining = intents.filter((intent) => !pendingIntent(intent));
      const terminal = remaining.every(({ status }) =>
        isTerminalIntentStatus(status),
      );
      const failed =
        terminal &&
        remaining.every(
          ({ status }) => status === "rejected" || status === "cancelled",
        );
      updatePipelineRunStage(
        run.id,
        {
          stage: failed ? "failed" : "partial",
          errorSummary: "execute-date-expired",
          finishedAt: terminal ? Date.now() : null,
        },
        db,
      );
      appendExecutionAuditEvent(
        {
          deploymentId: current.deploymentId,
          runId: run.id,
          eventType: "execution_calendar_overdue",
          details: {
            executeDate: run.executeDate,
            intents: pending.length,
            reason: "execute-date-expired",
          },
        },
        db,
      );
      return pending.length;
    })
    .immediate();
}
