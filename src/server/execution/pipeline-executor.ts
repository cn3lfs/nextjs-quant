import type Database from "better-sqlite3";
import Big from "big.js";
import { z } from "zod";
import {
  canTransitionIntentStatus,
  isLiveVenueKind,
  isTerminalIntentStatus,
  type PipelineStage,
} from "trading-strategies";
import { sqlite } from "../db";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, real, text } from "drizzle-orm/sqlite-core";
import { and, eq, inArray } from "drizzle-orm";
import {
  getDeployment,
  getPipelineGlobalConfig,
  type DeploymentRecord,
} from "../db/deployment-repository";
import {
  appendExecutionAuditEvent,
  claimIntentForSubmission,
  getIntent,
  getPipelineRun,
  listIntentsByRun,
  transitionIntentStatus,
  updatePipelineRunStage,
  type OrderIntentRecord,
} from "../db/pipeline-repository";
import {
  resolveVenueAdapter,
  submissionDateExpired,
  type VenueOrderResult,
  type VenueRouterDeps,
} from "./venue-router";

type Db = Database.Database;
type Intent = OrderIntentRecord;
// Narrow projection for indexed lookup and same-status fill evidence. The repository
// owns intent creation, status transitions, decoding and the submission fence.
const orderEvidence = sqliteTable("execution_order_intents", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  deploymentId: text("deployment_id").notNull(),
  executeDate: text("execute_date").notNull(),
  status: text("status").notNull(),
  venueOrderId: text("venue_order_id"),
  filledQuantity: real("filled_quantity"),
  averageFillPrice: real("average_fill_price"),
  errorSummary: text("error_summary"),
  updatedAt: integer("updated_at").notNull(),
});
export type PipelineQuoteSnapshot = {
  symbol: string;
  openPrice: number | null;
  lastPrice: number | null;
  prevClose: number | null;
  upperLimit: number | null;
  lowerLimit: number | null;
  suspended: boolean;
};
export interface PipelineExecutorDeps extends VenueRouterDeps {
  readQuote?: (
    symbol: string,
    executeDate: string,
  ) => PipelineQuoteSnapshot | null | Promise<PipelineQuoteSnapshot | null>;
}
type RunInput = {
  runId: string;
  executeDate: string;
  manualApproved?: boolean;
  deps?: PipelineExecutorDeps;
};
const pending = (i: Intent) => i.status === "planned" || i.status === "queued";
const reconciliationStatuses = [
  "submitting",
  "submitted",
  "partial_filled",
  "unknown_reconcile",
] as const;
// Leave time for the active request (built-in live transports time out at 10 seconds).
const submittingGraceMs = 30_000;
function stageFor(intents: Intent[], current: PipelineStage): PipelineStage {
  if (!intents.length)
    return current === "risk_checked" ? "completed" : current;
  const failed = intents.filter(
    (i) => i.status === "rejected" || i.status === "cancelled",
  ).length;
  if (intents.every((i) => isTerminalIntentStatus(i.status)))
    return failed === 0
      ? "completed"
      : failed === intents.length
        ? "failed"
        : "partial";
  if (intents.every(pending)) return current;
  return failed ? "partial" : "executing";
}
function refreshStage(runId: string, db: Db) {
  return new AccountWorkspaceRepository(db).atomic(() => {
    const run = getPipelineRun(runId, db)!;
    const intents = listIntentsByRun(runId, db);
    const stage = stageFor(intents, run.stage);
    const done = intents.every((i) => isTerminalIntentStatus(i.status));
    if (
      stage !== run.stage ||
      (stage === "partial" && done && run.finishedAt == null)
    )
      updatePipelineRunStage(
        runId,
        { stage, finishedAt: done ? Date.now() : null },
        db,
      );
    return stage;
  });
}
function gate(
  deployment: DeploymentRecord,
  intents: Intent[],
  approved: boolean | undefined,
  db: Db,
) {
  const config = getPipelineGlobalConfig(db);
  if (deployment.status !== "active") return "deployment-inactive";
  if (
    deployment.executionMode !== "shadow" &&
    config.autoLiveEnabled !== true &&
    intents.some((i) => isLiveVenueKind(i.venueKind))
  )
    return "live-kill-switch-off";
  switch (deployment.executionMode) {
    case "shadow":
      return "shadow-mode";
    case "manual_confirm":
      return approved === true ? null : "manual-approval-required";
    case "auto_live":
      return config.autoLiveEnabled === true &&
        intents.every(
          (i) =>
            i.venueKind === i.venueBinding.kind && isLiveVenueKind(i.venueKind),
        )
        ? null
        : "live-kill-switch-off";
    case "auto_sim":
      return config.autoSimEnabled &&
        intents.every(
          (i) =>
            i.venueKind === i.venueBinding.kind &&
            !isLiveVenueKind(i.venueKind),
        )
        ? null
        : "kill-switch-off";
  }
}
const positive = (p: number | null): p is number =>
  p !== null && Number.isFinite(p) && p > 0;
function quoteDecision(
  i: Intent,
  q: PipelineQuoteSnapshot | null,
  deployment: DeploymentRecord,
) {
  if (!q || q.symbol.toUpperCase() !== i.symbol.toUpperCase())
    return "缺少标的执行行情";
  if (q.suspended) return "标的停牌，取消本次委托";
  const price = q.openPrice ?? q.lastPrice;
  if (!positive(price) || (q.lastPrice !== null && !positive(q.lastPrice)))
    return "缺少有效开盘价或最新价";
  if (deployment.market === "cn-equity") {
    if (
      (q.upperLimit !== null && !positive(q.upperLimit)) ||
      (q.lowerLimit !== null && !positive(q.lowerLimit)) ||
      (q.upperLimit !== null &&
        q.lowerLimit !== null &&
        q.lowerLimit > q.upperLimit)
    )
      return "当日涨跌停行情无效";
    const last = q.lastPrice ?? price;
    if (i.side === "BUY") {
      if (q.upperLimit !== null && last >= q.upperLimit)
        return "买入触及涨停，取消本次委托";
      if (
        new Big(price).gt(
          new Big(i.referencePrice).times(
            new Big(1).plus(deployment.riskPolicy.maxGapPct),
          ),
        )
      )
        return "开盘向上跳空超过风控上限，取消本次买入";
    } else if (q.lowerLimit !== null && last <= q.lowerLimit)
      return "卖出触及跌停，取消本次委托";
  }
  return price;
}
function unresolved(): VenueOrderResult {
  return {
    status: "unknown_reconcile",
    venueOrderId: null,
    filledQuantity: null,
    averageFillPrice: null,
    errorSummary: "通道结果未确认，等待对账",
  };
}
function consistent(i: Intent, r: VenueOrderResult) {
  const qty = r.filledQuantity;
  return (
    !(i.venueOrderId && r.venueOrderId && i.venueOrderId !== r.venueOrderId) &&
    (qty === null || (qty >= (i.filledQuantity ?? 0) && qty <= i.quantity)) &&
    (r.status !== "filled" || qty === i.quantity) &&
    (r.status !== "partial_filled" ||
      (qty !== null && qty > 0 && qty < i.quantity)) &&
    (r.status !== "submitted" || (qty ?? i.filledQuantity ?? 0) === 0)
  );
}
function applyResult(observed: Intent, reported: VenueOrderResult, db: Db) {
  return new AccountWorkspaceRepository(db).atomic(() => {
    // A slower poll cannot overwrite newer fill evidence, even within the same millisecond.
    const i = getIntent(observed.id, db);
    if (
      !i ||
      i.status !== observed.status ||
      i.updatedAt !== observed.updatedAt ||
      i.filledQuantity !== observed.filledQuantity ||
      i.averageFillPrice !== observed.averageFillPrice ||
      i.venueOrderId !== observed.venueOrderId ||
      isTerminalIntentStatus(i.status)
    )
      return;
    const accepted =
      consistent(i, reported) &&
      (reported.status === i.status ||
        canTransitionIntentStatus(i.status, reported.status));
    const r = accepted ? reported : unresolved();
    const patch = {
      venueOrderId:
        accepted && isLiveVenueKind(i.venueKind)
          ? r.venueOrderId
          : (r.venueOrderId ?? i.venueOrderId),
      filledQuantity: r.filledQuantity ?? i.filledQuantity,
      averageFillPrice:
        r.averageFillPrice ??
        (r.filledQuantity !== null &&
        r.filledQuantity !== (i.filledQuantity ?? 0)
          ? null
          : i.averageFillPrice),
      errorSummary: r.errorSummary ?? null,
    };
    if (r.status !== i.status) {
      transitionIntentStatus(i.id, r.status, patch, db);
    } else if (
      patch.filledQuantity !== i.filledQuantity ||
      patch.averageFillPrice !== i.averageFillPrice ||
      patch.venueOrderId !== i.venueOrderId ||
      patch.errorSummary !== i.errorSummary
    ) {
      // The state machine has no self transitions. A second partial fill advances evidence only.
      drizzle(db)
        .update(orderEvidence)
        .set({ ...patch, updatedAt: Date.now() })
        .where(eq(orderEvidence.id, i.id))
        .run();
      appendExecutionAuditEvent(
        {
          deploymentId: i.deploymentId,
          runId: i.runId,
          intentId: i.id,
          eventType: "intent_reconciled",
          details: { status: i.status, filledQuantity: patch.filledQuantity },
        },
        db,
      );
    }
  });
}
async function executeOne(
  i: Intent,
  deployment: DeploymentRecord,
  input: RunInput,
  db: Db,
) {
  if (submissionDateExpired(i, input.deps?.now)) return "execute-date-expired";
  let executePrice = i.referencePrice;
  let quote: PipelineQuoteSnapshot | null = null;
  if (input.deps?.readQuote) {
    try {
      quote = await input.deps.readQuote(i.symbol, input.executeDate);
    } catch {
      /* Missing evidence prevents submission. */
    }
    const decision = quoteDecision(i, quote, deployment);
    if (typeof decision === "string") {
      new AccountWorkspaceRepository(db).atomic(() => {
        const current = getIntent(i.id, db);
        if (current && pending(current))
          transitionIntentStatus(
            i.id,
            "rejected",
            { errorSummary: decision },
            db,
          );
      });
      return;
    }
    executePrice = decision;
  }
  if (submissionDateExpired(i, input.deps?.now)) return "execute-date-expired";
  const adapter = resolveVenueAdapter(i.venueBinding, input.deps);
  const claim = claimIntentForSubmission(
    i.id,
    { manualApproved: input.manualApproved, now: input.deps?.now?.() },
    db,
  );
  if (!claim.claimed) {
    if (claim.reason === "invalid-status" || claim.reason === "not-found")
      return;
    return claim.reason === "execution-mode-blocked"
      ? "shadow-mode"
      : claim.reason;
  }
  let response: VenueOrderResult;
  try {
    response = await adapter.submitOrder(claim.intent, {
      executePrice,
      executeDate: input.executeDate,
      db,
      ...(quote ? { quote } : {}),
    });
  } catch {
    response = unresolved();
  }
  applyResult(claim.intent, response, db);
  if (
    response.status === "rejected" &&
    (response.errorSummary === "live-kill-switch-off" ||
      response.errorSummary === "execute-date-expired")
  )
    return response.errorSummary;
}
const skipped = (reason: string) => ({ skipped: true as const, reason });
async function execute(input: RunInput, db: Db, onlyIntent?: string) {
  if (db.inTransaction) throw new Error("流水线执行不能在外部事务内运行");
  z.string().date().parse(input.executeDate);
  const run = getPipelineRun(input.runId, db);
  if (!run) throw new Error("流水线运行不存在");
  const deployment = getDeployment(run.deploymentId, db);
  if (!deployment) throw new Error("策略部署不存在");
  const stop = (reason: string) => {
    if (reason === "kill-switch-off" || reason === "live-kill-switch-off")
      appendExecutionAuditEvent(
        {
          deploymentId: deployment.id,
          runId: run.id,
          eventType: "execution_blocked",
          details: { reason },
        },
        db,
      );
    return skipped(reason);
  };
  const intents = listIntentsByRun(run.id, db);
  const reason = gate(deployment, intents, input.manualApproved, db);
  if (reason) return stop(reason);
  if (onlyIntent && deployment.executionMode !== "manual_confirm")
    return skipped("manual-confirm-mode-required");
  if (input.executeDate !== run.executeDate)
    return skipped("execute-date-mismatch");
  const eligible = intents.filter(
    (i) =>
      pending(i) &&
      i.executeDate === input.executeDate &&
      (!onlyIntent || i.id === onlyIntent),
  );
  for (const phase of [1, 2] as const) {
    const orders = eligible.filter((i) => i.phase === phase);
    if (
      phase === 2 &&
      orders.length &&
      listIntentsByRun(run.id, db).some(
        (i) => i.phase === 1 && !isTerminalIntentStatus(i.status),
      )
    ) {
      if (onlyIntent) return skipped("pending-sell-phase");
      break;
    }
    for (const i of orders) {
      const blocked = await executeOne(i, deployment, input, db);
      if (blocked) {
        refreshStage(run.id, db);
        return stop(blocked);
      }
    }
  }
  const stage = refreshStage(run.id, db);
  return { skipped: false as const, runId: run.id, stage };
}
export function executePipelineRun(input: RunInput, db: Db = sqlite()) {
  return execute(input, db);
}
export async function approveAndExecuteIntent(
  input: { intentId: string; executeDate: string; deps?: PipelineExecutorDeps },
  db: Db = sqlite(),
) {
  const row = drizzle(db)
    .select({ runId: orderEvidence.runId })
    .from(orderEvidence)
    .where(eq(orderEvidence.id, input.intentId))
    .get();
  if (!row) throw new Error("订单意图不存在");
  return execute(
    { ...input, runId: row.runId, manualApproved: true },
    db,
    input.intentId,
  );
}
export async function reconcilePendingIntents(
  input: {
    deploymentId?: string;
    executeDate?: string;
    runId?: string;
    deps?: PipelineExecutorDeps;
  },
  db: Db = sqlite(),
) {
  if (db.inTransaction) throw new Error("流水线对账不能在外部事务内运行");
  const submittingCutoff =
    (input.deps?.now?.() ?? Date.now()) - submittingGraceMs;
  const runs = drizzle(db)
    .selectDistinct({ runId: orderEvidence.runId })
    .from(orderEvidence)
    .where(
      and(
        inArray(orderEvidence.status, [...reconciliationStatuses]),
        input.runId === undefined
          ? undefined
          : eq(orderEvidence.runId, input.runId),
        input.deploymentId === undefined
          ? undefined
          : eq(orderEvidence.deploymentId, input.deploymentId),
        input.executeDate === undefined
          ? undefined
          : eq(orderEvidence.executeDate, input.executeDate),
      ),
    )
    .orderBy(orderEvidence.runId)
    .all();
  let queried = 0;
  for (const { runId } of runs) {
    for (const i of listIntentsByRun(runId, db)) {
      if (
        !reconciliationStatuses.some((status) => status === i.status) ||
        (i.status === "submitting" && i.updatedAt > submittingCutoff)
      )
        continue;
      let response: VenueOrderResult;
      try {
        response = await resolveVenueAdapter(
          i.venueBinding,
          input.deps,
        ).reconcileOrder(i, { db });
      } catch {
        response = unresolved();
      }
      applyResult(i, response, db);
      queried++;
    }
    refreshStage(runId, db);
  }
  return { queried };
}
