import type Database from "better-sqlite3";
import { z } from "zod";
import { sqlite } from "./index";

const idSchema = z.string().trim().min(1);
const timestampSchema = z.number().int().safe().nonnegative();
const pageSizeSchema = z.number().int().min(1).max(1000).default(50);
const nonEmptyText = z.string().trim().min(1);

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(jsonSchema),
  ]),
);

const auditInputSchema = z
  .object({
    deploymentId: idSchema,
    runId: idSchema.nullable().default(null),
    intentId: idSchema.nullable().default(null),
    eventType: nonEmptyText,
    details: jsonSchema.default(null),
    createdAt: timestampSchema.optional(),
  })
  .strict();

export type AppendExecutionAuditEventInput = z.input<typeof auditInputSchema>;
export type ExecutionAuditEvent = Omit<
  z.output<typeof auditInputSchema>,
  "createdAt"
> & {
  id: number;
  createdAt: number;
};

type ExecutionAuditRow = Omit<ExecutionAuditEvent, "details"> & {
  detailsJson: string;
};

const auditColumns = `id,deployment_id AS deploymentId,run_id AS runId,
  intent_id AS intentId,event_type AS eventType,details_json AS detailsJson,created_at AS createdAt`;

function decodeAuditEvent({
  detailsJson,
  ...row
}: ExecutionAuditRow): ExecutionAuditEvent {
  return { ...row, details: jsonSchema.parse(JSON.parse(detailsJson)) };
}

export function appendExecutionAuditEvent(
  raw: AppendExecutionAuditEventInput,
  connection: Database.Database = sqlite(),
) {
  const event = auditInputSchema.parse(raw);
  let runId = event.runId;
  if (event.intentId) {
    const intent = connection
      .prepare<[string], { deploymentId: string; runId: string }>(
        "SELECT deployment_id AS deploymentId, run_id AS runId FROM execution_order_intents WHERE id=?",
      )
      .get(event.intentId);
    if (
      !intent ||
      intent.deploymentId !== event.deploymentId ||
      (runId && runId !== intent.runId)
    )
      throw new Error("执行审计事件的订单意图与运行或部署不匹配");
    runId = intent.runId;
  } else if (
    runId &&
    !connection
      .prepare("SELECT 1 FROM pipeline_runs WHERE id=? AND deployment_id=?")
      .get(runId, event.deploymentId)
  ) {
    throw new Error("执行审计事件的运行与部署不匹配");
  }
  const row = connection
    .prepare<object, ExecutionAuditRow>(
      `INSERT INTO execution_audit_events (deployment_id,run_id,intent_id,event_type,details_json,created_at)
       VALUES (@deploymentId,@runId,@intentId,@eventType,@detailsJson,@createdAt)
       RETURNING ${auditColumns}`,
    )
    .get({
      ...event,
      runId,
      detailsJson: JSON.stringify(event.details),
      createdAt: event.createdAt ?? Date.now(),
    })!;
  return decodeAuditEvent(row);
}

const auditListSchema = z
  .object({
    deploymentId: idSchema,
    runId: idSchema.optional(),
    limit: pageSizeSchema,
    after: z
      .object({
        createdAt: timestampSchema,
        id: z.number().int().safe().positive(),
      })
      .optional(),
  })
  .strict();

export function listExecutionAuditEvents(
  options: z.input<typeof auditListSchema>,
  connection: Database.Database = sqlite(),
) {
  const { deploymentId, runId, limit, after } = auditListSchema.parse(options);
  const rows = connection
    .prepare<(number | string)[], ExecutionAuditRow>(
      `SELECT ${auditColumns} FROM execution_audit_events WHERE deployment_id=?
       ${runId ? "AND run_id=?" : ""}
       ${after ? "AND (created_at,id) < (?,?)" : ""}
       ORDER BY created_at DESC,id DESC LIMIT ?`,
    )
    .all(
      deploymentId,
      ...(runId ? [runId] : []),
      ...(after ? [after.createdAt, after.id] : []),
      limit + 1,
    );
  const items = rows.slice(0, limit).map(decodeAuditEvent);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : null,
  };
}
