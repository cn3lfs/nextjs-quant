import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import {
  buildIntentIdempotencyKey,
  canTransitionIntentStatus,
  executionVenueKinds,
  isLiveVenueKind,
  isTerminalIntentStatus,
  orderIntentStatuses,
  pipelineStages,
  pipelineTriggerKinds,
  venueBindingSchema,
  type OrderIntentStatus,
  type VenueBinding,
} from "trading-strategies";
import { z } from "zod";
import {
  getDeployment,
  getPipelineGlobalConfig,
} from "./deployment-repository";
import {
  appendExecutionAuditEvent,
  jsonSchema,
  listExecutionAuditEvents,
  type AppendExecutionAuditEventInput,
  type ExecutionAuditEvent,
  type JsonValue,
} from "./execution-audit";
import { sqlite } from "./index";

export {
  appendExecutionAuditEvent,
  jsonSchema,
  listExecutionAuditEvents,
  type AppendExecutionAuditEventInput,
  type ExecutionAuditEvent,
};

const idSchema = z.string().trim().min(1);
const dateSchema = z.string().date();
const timestampSchema = z.number().int().safe().nonnegative();
const pageSizeSchema = z.number().int().min(1).max(1000).default(50);
const intentStatusSchema = z.enum(orderIntentStatuses);
const terminalIntentStatuses = orderIntentStatuses.filter(
  isTerminalIntentStatus,
);
const nonEmptyText = z.string().trim().min(1);

const newRunSchema = z
  .object({
    deploymentId: idSchema,
    decisionDate: dateSchema,
    runSlot: nonEmptyText.default("daily"),
    executeDate: dateSchema,
    triggerKind: z.enum(pipelineTriggerKinds),
  })
  .strict()
  .refine(({ executeDate, decisionDate }) => executeDate >= decisionDate, {
    path: ["executeDate"],
    message: "执行日不能早于决策日",
  });
const stagePatchSchema = z
  .object({
    stage: z.enum(pipelineStages),
    universeSnapshot: jsonSchema.optional(),
    signals: jsonSchema.optional(),
    riskVerdict: jsonSchema.optional(),
    errorSummary: z.string().nullable().optional(),
    finishedAt: timestampSchema.nullable().optional(),
  })
  .strict();
export type CreatePipelineRunInput = z.input<typeof newRunSchema>;
export type PipelineRunStagePatch = z.input<typeof stagePatchSchema>;
export type PipelineRunRecord = z.output<typeof newRunSchema> &
  Required<z.output<typeof stagePatchSchema>> & {
    id: string;
    startedAt: number;
  };

type PipelineRunRow = Omit<
  PipelineRunRecord,
  "universeSnapshot" | "signals" | "riskVerdict"
> & {
  universeSnapshotJson: string | null;
  signalsJson: string | null;
  riskVerdictJson: string | null;
};
const runColumns = `id,deployment_id AS deploymentId,decision_date AS decisionDate,run_slot AS runSlot,
  execute_date AS executeDate,trigger_kind AS triggerKind,stage,
  universe_snapshot_json AS universeSnapshotJson,signals_json AS signalsJson,
  risk_verdict_json AS riskVerdictJson,error_summary AS errorSummary,
  started_at AS startedAt,finished_at AS finishedAt`;

function decodeRun({
  universeSnapshotJson,
  signalsJson,
  riskVerdictJson,
  ...row
}: PipelineRunRow): PipelineRunRecord {
  return {
    ...row,
    universeSnapshot: decodeJson(universeSnapshotJson),
    signals: decodeJson(signalsJson),
    riskVerdict: decodeJson(riskVerdictJson),
  };
}

function decodeJson(value: string | null): JsonValue {
  return value === null ? null : jsonSchema.parse(JSON.parse(value));
}

function encodeJson(value: JsonValue) {
  return value === null ? null : JSON.stringify(value);
}

export function getPipelineRun(
  runId: string,
  connection: Database.Database = sqlite(),
) {
  const row = connection
    .prepare<[string], PipelineRunRow>(
      `SELECT ${runColumns} FROM pipeline_runs WHERE id=?`,
    )
    .get(idSchema.parse(runId));
  return row ? decodeRun(row) : null;
}

export function findPipelineRun(
  deploymentId: string,
  decisionDate: string,
  runSlotOrConnection: string | Database.Database = "daily",
  connection?: Database.Database,
) {
  const runSlot =
    typeof runSlotOrConnection === "string" ? runSlotOrConnection : "daily";
  const db =
    typeof runSlotOrConnection === "string"
      ? (connection ?? sqlite())
      : runSlotOrConnection;
  const row = db
    .prepare<[string, string, string], PipelineRunRow>(
      `SELECT ${runColumns} FROM pipeline_runs WHERE deployment_id=? AND decision_date=? AND run_slot=?`,
    )
    .get(
      idSchema.parse(deploymentId),
      dateSchema.parse(decisionDate),
      nonEmptyText.parse(runSlot),
    );
  return row ? decodeRun(row) : null;
}

function requirePipelineRun(runId: string, connection: Database.Database) {
  const run = getPipelineRun(runId, connection);
  if (!run) throw new Error(`流水线运行不存在：${runId}`);
  return run;
}

export function getOrCreatePipelineRun(
  raw: CreatePipelineRunInput,
  connection: Database.Database = sqlite(),
) {
  const input = newRunSchema.parse(raw);
  return connection
    .transaction(() => {
      const existing = findPipelineRun(
        input.deploymentId,
        input.decisionDate,
        input.runSlot,
        connection,
      );
      if (existing) return { run: existing, created: false };
      const row = connection
        .prepare<object, PipelineRunRow>(
          `INSERT INTO pipeline_runs (id,deployment_id,decision_date,run_slot,execute_date,trigger_kind,stage,started_at)
         VALUES (@id,@deploymentId,@decisionDate,@runSlot,@executeDate,@triggerKind,'pending',@startedAt)
         RETURNING ${runColumns}`,
        )
        .get({ ...input, id: randomUUID(), startedAt: Date.now() })!;
      appendExecutionAuditEvent(
        {
          deploymentId: row.deploymentId,
          runId: row.id,
          eventType: "pipeline_run_created",
          details: { triggerKind: row.triggerKind, stage: row.stage },
          createdAt: row.startedAt,
        },
        connection,
      );
      return { run: decodeRun(row), created: true };
    })
    .immediate();
}

const runListSchema = z
  .object({
    deploymentId: idSchema.optional(),
    limit: pageSizeSchema,
    after: z
      .object({
        decisionDate: dateSchema,
        startedAt: timestampSchema,
        id: idSchema,
      })
      .optional(),
  })
  .strict();

export function listPipelineRuns(
  options: z.input<typeof runListSchema> = {},
  connection: Database.Database = sqlite(),
) {
  const { deploymentId, limit, after } = runListSchema.parse(options);
  const rows = connection
    .prepare<(string | number)[], PipelineRunRow>(
      `SELECT ${runColumns} FROM pipeline_runs WHERE 1=1
       ${deploymentId ? "AND deployment_id=?" : ""}
       ${after ? "AND (decision_date,started_at,id) < (?,?,?)" : ""}
       ORDER BY decision_date DESC,started_at DESC,id DESC LIMIT ?`,
    )
    .all(
      ...(deploymentId ? [deploymentId] : []),
      ...(after ? [after.decisionDate, after.startedAt, after.id] : []),
      limit + 1,
    );
  const items = rows.slice(0, limit).map(decodeRun);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? {
            decisionDate: last.decisionDate,
            startedAt: last.startedAt,
            id: last.id,
          }
        : null,
  };
}

export function updatePipelineRunStage(
  runId: string,
  raw: PipelineRunStagePatch,
  connection: Database.Database = sqlite(),
) {
  const patch = stagePatchSchema.parse(raw);
  return connection
    .transaction(() => {
      const current = requirePipelineRun(runId, connection);
      const now = Date.now();
      const updated: PipelineRunRecord = {
        ...current,
        stage: patch.stage,
        universeSnapshot:
          patch.universeSnapshot === undefined
            ? current.universeSnapshot
            : patch.universeSnapshot,
        signals: patch.signals === undefined ? current.signals : patch.signals,
        riskVerdict:
          patch.riskVerdict === undefined
            ? current.riskVerdict
            : patch.riskVerdict,
        errorSummary:
          patch.errorSummary === undefined
            ? current.errorSummary
            : patch.errorSummary,
        finishedAt:
          patch.finishedAt === undefined
            ? current.finishedAt
            : patch.finishedAt,
      };
      connection
        .prepare(
          `UPDATE pipeline_runs SET stage=@stage,universe_snapshot_json=@universeSnapshotJson,
         signals_json=@signalsJson,risk_verdict_json=@riskVerdictJson,error_summary=@errorSummary,
         finished_at=@finishedAt WHERE id=@id`,
        )
        .run({
          ...updated,
          universeSnapshotJson: encodeJson(updated.universeSnapshot),
          signalsJson: encodeJson(updated.signals),
          riskVerdictJson: encodeJson(updated.riskVerdict),
        });
      let resetConsecutiveFailures = false;
      if (current.stage !== "completed" && updated.stage === "completed") {
        resetConsecutiveFailures =
          connection
            .prepare(
              `UPDATE strategy_deployments SET consecutive_failures=0,updated_at=?
           WHERE id=? AND consecutive_failures>0 AND updated_at<=?`,
            )
            .run(now, current.deploymentId, current.startedAt).changes > 0;
      }
      appendExecutionAuditEvent(
        {
          deploymentId: current.deploymentId,
          runId: current.id,
          eventType: "pipeline_run_stage_updated",
          details: {
            from: current.stage,
            to: updated.stage,
            resetConsecutiveFailures,
          },
          createdAt: now,
        },
        connection,
      );
      return updated;
    })
    .immediate();
}

const positiveNumber = z.number().finite().positive();
const intentInputSchema = z
  .object({
    id: idSchema.optional(),
    runId: idSchema,
    deploymentId: idSchema,
    decisionDate: dateSchema.optional(),
    executeDate: dateSchema.optional(),
    venueKind: z.enum(executionVenueKinds),
    venueBinding: venueBindingSchema.optional(),
    symbol: nonEmptyText,
    side: z.enum(["BUY", "SELL"]),
    phase: z.union([z.literal(1), z.literal(2)]),
    quantity: positiveNumber,
    referencePrice: positiveNumber,
    status: z.enum(["planned", "queued"]).default("planned"),
  })
  .strict()
  .refine(({ side, phase }) => (side === "SELL" ? phase === 1 : phase === 2), {
    path: ["phase"],
    message: "卖单必须为第 1 阶段，买单必须为第 2 阶段",
  });
const intentPatchSchema = z
  .object({
    venueOrderId: nonEmptyText.nullable().optional(),
    filledQuantity: z.number().finite().nonnegative().nullable().optional(),
    averageFillPrice: positiveNumber.nullable().optional(),
    errorSummary: z.string().nullable().optional(),
  })
  .strict();
export type InsertOrderIntentInput = z.input<typeof intentInputSchema>;
export type OrderIntentStatusPatch = z.input<typeof intentPatchSchema>;
export type OrderIntentRecord = Omit<
  z.output<typeof intentInputSchema>,
  "id" | "status" | "decisionDate" | "executeDate" | "venueBinding"
> &
  Required<z.output<typeof intentPatchSchema>> & {
    id: string;
    decisionDate: string;
    executeDate: string;
    idempotencyKey: string;
    status: OrderIntentStatus;
    venueBinding: VenueBinding;
    createdAt: number;
    updatedAt: number;
  };

type OrderIntentRow = Omit<OrderIntentRecord, "venueBinding"> & {
  venueBindingJson: string;
};
const intentColumns = `id,run_id AS runId,deployment_id AS deploymentId,
  decision_date AS decisionDate,execute_date AS executeDate,
  idempotency_key AS idempotencyKey,venue_kind AS venueKind,symbol,side,phase,
  venue_binding_json AS venueBindingJson,
  quantity,reference_price AS referencePrice,status,venue_order_id AS venueOrderId,
  filled_quantity AS filledQuantity,average_fill_price AS averageFillPrice,
  error_summary AS errorSummary,created_at AS createdAt,updated_at AS updatedAt`;

function decodeIntent({
  venueBindingJson,
  ...row
}: OrderIntentRow): OrderIntentRecord {
  return {
    ...row,
    venueBinding: venueBindingSchema.parse(JSON.parse(venueBindingJson)),
  };
}

export function insertOrderIntents(
  runId: string,
  raw: readonly InsertOrderIntentInput[],
  connection: Database.Database = sqlite(),
) {
  const inputs = z.array(intentInputSchema).parse(raw);
  return connection
    .transaction(() => {
      const run = requirePipelineRun(runId, connection);
      const deployment = getDeployment(run.deploymentId, connection);
      if (!deployment) throw new Error(`策略部署不存在：${run.deploymentId}`);
      const binding = deployment.venueBinding;
      for (const input of inputs) {
        if (input.runId !== run.id || input.deploymentId !== run.deploymentId)
          throw new Error("订单意图与流水线运行或部署不匹配");
        if (
          input.venueKind !== binding.kind ||
          (input.venueBinding !== undefined &&
            !isDeepStrictEqual(input.venueBinding, binding))
        )
          throw new Error("订单意图与部署的交易通道或账户绑定不匹配");
        if (
          (input.decisionDate !== undefined &&
            input.decisionDate !== run.decisionDate) ||
          (input.executeDate !== undefined &&
            input.executeDate !== run.executeDate)
        )
          throw new Error("订单意图日期与流水线运行不匹配");
      }
      if (inputs.length === 0) return [];

      const existingBindings = connection
        .prepare<
          [string],
          Pick<OrderIntentRow, "venueKind" | "venueBindingJson">
        >(
          `SELECT DISTINCT venue_kind AS venueKind,venue_binding_json AS venueBindingJson
           FROM execution_order_intents WHERE run_id=?`,
        )
        .all(run.id);
      if (
        existingBindings.some(
          ({ venueKind, venueBindingJson }) =>
            venueKind !== binding.kind ||
            !isDeepStrictEqual(
              venueBindingSchema.parse(JSON.parse(venueBindingJson)),
              binding,
            ),
        )
      )
        throw new Error(
          "订单意图与该流水线运行已锁定的交易通道或账户绑定不匹配",
        );

      if (
        inputs.some(({ phase }) => phase === 1) &&
        connection
          .prepare(
            `SELECT 1 FROM execution_audit_events AS event
           JOIN execution_order_intents AS intent ON intent.id=event.intent_id
           WHERE event.deployment_id=? AND event.run_id=? AND event.event_type='intent_claimed'
             AND intent.phase=2 LIMIT 1`,
          )
          .get(run.deploymentId, run.id)
      )
        throw new Error("买单已进入提交阶段，无法再添加卖单");

      const now = Date.now();
      const venueBindingJson = JSON.stringify(binding);
      const insert = connection.prepare<object, OrderIntentRow>(
        `INSERT INTO execution_order_intents (
        id,run_id,deployment_id,decision_date,execute_date,idempotency_key,
        venue_kind,venue_binding_json,symbol,side,phase,quantity,reference_price,status,created_at,updated_at
      ) VALUES (
        @id,@runId,@deploymentId,@decisionDate,@executeDate,@idempotencyKey,
        @venueKind,@venueBindingJson,@symbol,@side,@phase,@quantity,@referencePrice,@status,@now,@now
      ) RETURNING ${intentColumns}`,
      );
      return inputs.map((input) => {
        const dates = {
          decisionDate: run.decisionDate,
          executeDate: run.executeDate,
        };
        const intent = decodeIntent(
          insert.get({
            ...input,
            ...dates,
            venueBindingJson,
            id: input.id ?? randomUUID(),
            idempotencyKey: buildIntentIdempotencyKey({
              ...input,
              ...dates,
              phase: String(input.phase),
              runSlot: run.runSlot,
            }),
            now,
          })!,
        );
        appendExecutionAuditEvent(
          {
            deploymentId: run.deploymentId,
            runId: run.id,
            intentId: intent.id,
            eventType: "intent_created",
            details: { status: intent.status },
            createdAt: now,
          },
          connection,
        );
        return intent;
      });
    })
    .immediate();
}

export function getIntent(id: string, connection: Database.Database) {
  const row = connection
    .prepare<[string], OrderIntentRow>(
      `SELECT ${intentColumns} FROM execution_order_intents WHERE id=?`,
    )
    .get(id);
  return row && decodeIntent(row);
}

function hasPendingSell(
  intent: OrderIntentRecord,
  connection: Database.Database,
) {
  return (
    intent.phase === 2 &&
    connection
      .prepare(
        `SELECT 1 FROM execution_order_intents
       WHERE run_id=? AND phase=1 AND status NOT IN (${terminalIntentStatuses.map(() => "?").join(",")})
       LIMIT 1`,
      )
      .get(intent.runId, ...terminalIntentStatuses) !== undefined
  );
}

function writeIntentStatus(
  current: OrderIntentRecord,
  status: OrderIntentStatus,
  patch: OrderIntentStatusPatch,
  now: number,
  connection: Database.Database,
) {
  const filledQuantity =
    patch.filledQuantity === undefined
      ? current.filledQuantity
      : patch.filledQuantity;
  if (
    current.filledQuantity !== null &&
    current.filledQuantity > 0 &&
    (filledQuantity === null || filledQuantity < current.filledQuantity)
  ) {
    throw new Error("已记录的成交数量不可清空或回退");
  }
  if (
    status === "filled" &&
    (filledQuantity === null ||
      filledQuantity <= 0 ||
      Math.abs(filledQuantity - current.quantity) > 1e-8)
  ) {
    throw new Error(
      "订单意图标记为已成交时，成交数量必须大于 0 且等于委托数量",
    );
  }
  const updated = connection
    .prepare<object, OrderIntentRow>(
      `UPDATE execution_order_intents SET status=@status,updated_at=@now,
       venue_order_id=@venueOrderId,filled_quantity=@filledQuantity,
       average_fill_price=@averageFillPrice,error_summary=@errorSummary
       WHERE id=@id RETURNING ${intentColumns}`,
    )
    .get({
      id: current.id,
      status,
      now,
      venueOrderId:
        patch.venueOrderId === undefined
          ? current.venueOrderId
          : patch.venueOrderId,
      filledQuantity,
      averageFillPrice:
        patch.averageFillPrice === undefined
          ? current.averageFillPrice
          : patch.averageFillPrice,
      errorSummary:
        patch.errorSummary === undefined
          ? current.errorSummary
          : patch.errorSummary,
    })!;
  appendExecutionAuditEvent(
    {
      deploymentId: current.deploymentId,
      runId: current.runId,
      intentId: current.id,
      eventType:
        status === "submitting" ? "intent_claimed" : "intent_status_changed",
      details: { from: current.status, to: status },
      createdAt: now,
    },
    connection,
  );
  return decodeIntent(updated);
}

const submissionBlockMessages = {
  "deployment-inactive": "策略部署未启用，无法提交订单",
  "execution-mode-blocked": "影子执行模式禁止提交订单",
  "manual-approval-required": "手动确认模式需要明确确认才能提交订单",
  "kill-switch-off": "自动模拟提交需要启用全局自动模拟开关并使用模拟交易通道",
  "live-kill-switch-off":
    "live-kill-switch-off：实盘提交需要启用全局自动实盘开关并使用实盘交易通道",
} as const;
type SubmissionBlockReason = keyof typeof submissionBlockMessages;

function submissionBlockReason(
  intent: OrderIntentRecord,
  manualApproved: boolean | undefined,
  connection: Database.Database,
): SubmissionBlockReason | undefined {
  const deployment = getDeployment(intent.deploymentId, connection);
  if (deployment?.status !== "active") return "deployment-inactive";

  const { executionMode } = deployment;
  if (executionMode === "shadow") return "execution-mode-blocked";
  const { autoSimEnabled, autoLiveEnabled } =
    getPipelineGlobalConfig(connection);
  const live = isLiveVenueKind(intent.venueKind);
  if (live && autoLiveEnabled !== true) return "live-kill-switch-off";
  if (executionMode === "manual_confirm") {
    return manualApproved === true ? undefined : "manual-approval-required";
  }

  if (executionMode === "auto_sim" && (!autoSimEnabled || live))
    return "kill-switch-off";
  if (executionMode === "auto_live" && !live) return "live-kill-switch-off";
}

const claimOptionsSchema = z
  .object({
    now: timestampSchema.optional(),
    manualApproved: z.boolean().optional(),
  })
  .strict();

export type ClaimIntentResult =
  | { claimed: true; intent: OrderIntentRecord }
  | {
      claimed: false;
      reason:
        | "not-found"
        | "invalid-status"
        | "pending-sell-phase"
        | SubmissionBlockReason;
    };

export function claimIntentForSubmission(
  intentId: string,
  optionsOrNow: z.input<typeof claimOptionsSchema> | number = {},
  connection: Database.Database = sqlite(),
): ClaimIntentResult {
  if (connection.inTransaction)
    throw new Error("订单提交认领不能在外部未提交事务内执行");
  const id = idSchema.parse(intentId);
  const { now = Date.now(), manualApproved } = claimOptionsSchema.parse(
    typeof optionsOrNow === "number" ? { now: optionsOrNow } : optionsOrNow,
  );
  return connection
    .transaction((): ClaimIntentResult => {
      const intent = getIntent(id, connection);
      if (!intent) return { claimed: false, reason: "not-found" };
      if (intent.status !== "planned" && intent.status !== "queued")
        return { claimed: false, reason: "invalid-status" };
      const reason = submissionBlockReason(intent, manualApproved, connection);
      if (reason) return { claimed: false, reason };
      if (hasPendingSell(intent, connection))
        return { claimed: false, reason: "pending-sell-phase" };
      return {
        claimed: true,
        intent: writeIntentStatus(intent, "submitting", {}, now, connection),
      };
    })
    .immediate();
}

const intentTransitionSchema = intentPatchSchema.extend({
  manualApproved: z.boolean().optional(),
});

export function transitionIntentStatus(
  intentId: string,
  toStatus: OrderIntentStatus,
  raw: z.input<typeof intentTransitionSchema> = {},
  connection: Database.Database = sqlite(),
) {
  if (toStatus === "submitting" && connection.inTransaction)
    throw new Error("订单提交认领不能在外部未提交事务内执行");
  const id = idSchema.parse(intentId);
  const status = intentStatusSchema.parse(toStatus);
  const { manualApproved, ...patch } = intentTransitionSchema.parse(raw);
  return connection
    .transaction(() => {
      const intent = getIntent(id, connection);
      if (!intent) throw new Error(`订单意图不存在：${id}`);
      if (!canTransitionIntentStatus(intent.status, status))
        throw new Error(
          `不允许的订单意图状态转换：${intent.status} -> ${status}`,
        );
      if (status === "submitting") {
        const reason = submissionBlockReason(
          intent,
          manualApproved,
          connection,
        );
        if (reason) throw new Error(submissionBlockMessages[reason]);
        if (hasPendingSell(intent, connection))
          throw new Error("pending-sell-phase：卖单尚未全部进入终态");
      }
      return writeIntentStatus(intent, status, patch, Date.now(), connection);
    })
    .immediate();
}

export function listIntentsByRun(
  runId: string,
  connection: Database.Database = sqlite(),
) {
  return connection
    .prepare<[string], OrderIntentRow>(
      `SELECT ${intentColumns} FROM execution_order_intents WHERE run_id=? ORDER BY phase,id`,
    )
    .all(idSchema.parse(runId))
    .map(decodeIntent);
}

export function cancelPendingIntent(
  intentId: string,
  reason = "用户手动取消",
  connection: Database.Database = sqlite(),
):
  | { ok: true; intent: OrderIntentRecord }
  | { ok: false; code: "NOT_FOUND" | "CONFLICT" } {
  return connection
    .transaction(() => {
      const intent = getIntent(intentId, connection);
      if (!intent) return { ok: false as const, code: "NOT_FOUND" as const };
      if (intent.status !== "planned" && intent.status !== "queued")
        return { ok: false as const, code: "CONFLICT" as const };
      return {
        ok: true as const,
        intent: transitionIntentStatus(
          intent.id,
          "cancelled",
          { errorSummary: reason },
          connection,
        ),
      };
    })
    .immediate();
}

export function listIntentsByDate(
  executeDate: string,
  statuses?: readonly OrderIntentStatus[],
  connection: Database.Database = sqlite(),
) {
  const date = dateSchema.parse(executeDate);
  const filter = z.array(intentStatusSchema).optional().parse(statuses);
  if (filter?.length === 0) return [];
  return connection
    .prepare<string[], OrderIntentRow>(
      `SELECT ${intentColumns} FROM execution_order_intents WHERE execute_date=?
       ${filter ? `AND status IN (${filter.map(() => "?").join(",")})` : ""}
       ORDER BY phase,id`,
    )
    .all(date, ...(filter ?? []))
    .map(decodeIntent);
}
