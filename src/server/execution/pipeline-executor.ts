import { observeFillDates } from "../pipeline/observed-fill-dates";
import type Database from "better-sqlite3";
import Big from "big.js";
import { z } from "zod";
import {
  canTransitionIntentStatus,
  extractVenueAccountKey,
  isLiveVenueKind,
  isTerminalIntentStatus,
  type VenueBinding,
  type PipelineStage,
} from "trading-strategies";
import { sqlite } from "../db";
import { chinaDate } from "~/lib/market/security-trading-status";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, real, text } from "drizzle-orm/sqlite-core";
import {
  and,
  eq,
  gt,
  lte,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { settlePendingRunDate } from "../pipeline/provisional-run";
import type { ExecutionCalendar } from "../pipeline/provisional-run";
import {
  executionRiskFactsChanged,
  limitExecutionBuy,
  readExecutionRiskSnapshot,
} from "../pipeline/execution-risk-limits";
import {
  getDeployment,
  getPipelineGlobalConfig,
  type DeploymentRecord,
} from "../db/deployment-repository";
import {
  appendExecutionAuditEvent,
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

import {
  createPipelineQuoteReader,
  ExecutionQuoteError,
  quoteTimeError,
  type PipelineQuoteSnapshot,
  type PipelineQuoteReader,
} from "./pipeline-quote-provider";
import {
  affordableBuy,
  arrivalEvidence,
  buyBalanceCoverage,
  sleeveFillCheckpoint,
  recordSellSettlement,
  type BuyCashSnapshot,
  sellProceeds,
} from "./pipeline-proceeds";
import {
  applySleeveFill,
  ownedHolding,
  fillAccount,
  preserveHistoricPartial,
} from "../pipeline/sleeve-fills";
import { recordExecutionFillLink } from "../db/execution-fill-link-repository";
import { normalizePoolSymbol } from "../db/pool-repository";
import { SimAccountRepository } from "../db/sim-account-repository";
import { listAccountSleeveHoldings } from "../db/sleeve-holding-repository";
import {
  normalizeSimSymbol,
  quantityDigits,
  replayPositions,
} from "../portfolio/sim-accounts/engine";

type Db = Database.Database;
type Intent = OrderIntentRecord;
// Narrow projection for indexed lookup and same-status fill evidence. The repository
// owns intent creation, decoding and general-purpose status transitions.
const orderEvidence = sqliteTable("execution_order_intents", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  deploymentId: text("deployment_id").notNull(),
  binding: text("venue_binding_json", { mode: "json" })
    .$type<VenueBinding>()
    .notNull(),
  side: text("side").notNull(),
  symbol: text("symbol").notNull(),
  executeDate: text("execute_date").notNull(),
  quantity: real("quantity").notNull(),
  status: text("status").notNull(),
  venueOrderId: text("venue_order_id"),
  filledQuantity: real("filled_quantity"),
  averageFillPrice: real("average_fill_price"),
  errorSummary: text("error_summary"),
  updatedAt: integer("updated_at").notNull(),
});
const fillLinks = sqliteTable("execution_fill_links", {
  intentId: text("intent_id"),
  source: text("fill_source").notNull(),
  fillId: text("fill_id").notNull(),
});
export type { PipelineQuoteSnapshot } from "./pipeline-quote-provider";
export interface PipelineExecutorDeps extends VenueRouterDeps {
  executionCalendar?: ExecutionCalendar;
  executionWindowCheck?: (
    nowMs: number,
    deployment?: DeploymentRecord,
  ) => boolean;
  readQuote?: PipelineQuoteReader;
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
function canSubmitSleeveSell(i: Intent, db: Db) {
  let free = new Big(ownedHolding(i, db)?.quantity ?? 0);
  if (free.lt(i.quantity)) return false;
  const outstanding = drizzle(db)
    .select({
      id: orderEvidence.id,
      quantity: orderEvidence.quantity,
      binding: orderEvidence.binding,
    })
    .from(orderEvidence)
    .where(
      and(
        eq(orderEvidence.deploymentId, i.deploymentId),
        eq(orderEvidence.side, "SELL"),
        eq(sql`${orderEvidence.symbol} COLLATE NOCASE`, i.symbol),
        ne(orderEvidence.id, i.id),
        inArray(orderEvidence.status, [...reconciliationStatuses]),
      ),
    )
    .all();
  const account = fillAccount(i.venueBinding);
  for (const other of outstanding) {
    const key = fillAccount(other.binding);
    if (
      key.accountScope === account.accountScope &&
      key.accountId === account.accountId
    )
      free = free
        .minus(other.quantity)
        .plus(sleeveFillCheckpoint(other.id, db)?.quantity ?? 0);
  }
  if (free.lt(i.quantity)) return false;
  if (i.venueBinding.kind !== "local_sim") return true;

  // A manual reduction after planning can leave the venue holding smaller
  // than the aggregate sleeve balances. Recheck against the live local ledger.
  const repo = new SimAccountRepository(db);
  const { market } = repo.account(i.venueBinding.simAccountId);
  const symbol = normalizeSimSymbol(i.symbol, market);
  const fills = repo.fills(account.accountId, symbol);
  if ((repo.latestDate(account.accountId) ?? "") > i.executeDate) return false;
  const position = replayPositions(fills, market, i.executeDate).get(symbol);
  if (!position) return false;
  const scale = new Big(10).pow(quantityDigits(market));
  const physical = new Big(position.quantity.toString()).div(scale);
  const sellable = new Big(position.sellable.toString()).div(scale);
  const foreign = listAccountSleeveHoldings(account, db)
    .filter(
      (row) =>
        normalizePoolSymbol(row.symbol) === normalizePoolSymbol(symbol) &&
        (row.ownerKind !== "deployment" || row.ownerId !== i.deploymentId),
    )
    .reduce((total, row) => total.plus(row.quantity), new Big(0));
  return physical.minus(foreign).gte(i.quantity) && sellable.gte(i.quantity);
}
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
    return "missing-execution-quote";
  if (q.suspended !== false) return "suspended";
  const price = q.lastPrice ?? q.openPrice;
  if (
    !positive(price) ||
    (q.openPrice !== null && !positive(q.openPrice)) ||
    (q.lastPrice !== null && !positive(q.lastPrice))
  )
    return "缺少有效开盘价或最新价";
  if (deployment.market === "cn-equity") {
    if (
      !positive(q.upperLimit) ||
      !positive(q.lowerLimit) ||
      q.lowerLimit >= q.upperLimit
    )
      return "missing-limit-bounds";
    if (price < q.lowerLimit || price > q.upperLimit)
      return "invalid-execution-price";
    if (i.side === "BUY" && price >= q.upperLimit)
      return "买入触及涨停，取消本次委托";
    if (i.side === "SELL" && price <= q.lowerLimit)
      return "卖出触及跌停，取消本次委托";
  }
  const gap = new Big(deployment.riskPolicy.maxGapPct);
  if (
    i.side === "BUY" &&
    new Big(Math.max(q.openPrice ?? price, price)).gt(
      new Big(i.referencePrice).times(gap.plus(1)),
    )
  )
    return "开盘向上跳空超过风控上限，取消本次买入";
  if (
    i.side === "SELL" &&
    new Big(Math.min(q.openPrice ?? price, price)).lt(
      new Big(i.referencePrice).times(new Big(1).minus(gap)),
    )
  )
    return "开盘向下跳空超过风控上限，取消本次卖出";
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
function applyResult(
  observed: Intent,
  reported: VenueOrderResult,
  db: Db,
  observedAt: number,
  fillDate: string | null = null,
) {
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
    preserveHistoricPartial(i, db);
    let accepted =
      consistent(i, reported) &&
      (reported.status === i.status ||
        canTransitionIntentStatus(i.status, reported.status));
    const binding = i.venueBinding;
    const account = fillAccount(binding);
    const orderId = reported.venueOrderId ?? i.venueOrderId;
    const fillIds = [
      ...new Set([
        ...(reported.fillIds ?? []),
        ...(reported.fillId ? [reported.fillId] : []),
      ]),
    ].map((id) =>
      JSON.stringify([
        extractVenueAccountKey(binding),
        i.symbol,
        i.executeDate,
        orderId,
        id,
      ]),
    );
    const confirmed =
      reported.status !== "unknown_reconcile" &&
      reported.status !== "submitted";
    if (accepted && confirmed && orderId && fillIds.length) {
      const links = drizzle(db)
        .select({ intentId: fillLinks.intentId })
        .from(fillLinks)
        .where(
          and(
            eq(fillLinks.source, account.fillSource),
            inArray(
              fillLinks.fillId,
              sql`(SELECT value FROM json_each(${JSON.stringify(fillIds)}))`,
            ),
          ),
        )
        .all();
      if (
        links.some((link) => link.intentId !== i.id) ||
        (links.length === fillIds.length &&
          (reported.filledQuantity ?? 0) > (i.filledQuantity ?? 0))
      )
        accepted = false;
    }
    let r = accepted ? reported : unresolved();
    if (
      accepted &&
      confirmed &&
      (r.filledQuantity ?? i.filledQuantity ?? 0) > 0
    ) {
      const quantity = r.filledQuantity ?? i.filledQuantity!;
      const average =
        r.averageFillPrice ??
        (quantity === i.filledQuantity ? i.averageFillPrice : null);
      if (
        !average ||
        (i.status === "unknown_reconcile" && r.filledQuantity === null)
      ) {
        // Retain the observed quantity for reconciliation and wait for a priced report.
        r = {
          ...r,
          status: "unknown_reconcile",
          errorSummary: "missing-venue-fill-evidence",
        };
      } else {
        const reportDay = i.venueKind.startsWith("crypto")
          ? new Date(observedAt).toISOString().slice(0, 10)
          : chinaDate(observedAt);
        // Local receipts and THS day orders are dated. For external orders
        // first seen on a later day, the order date alone cannot date a fill.
        const datedOrder =
          i.venueKind === "local_sim" ||
          i.venueKind === "ths_mock" ||
          reportDay === i.executeDate;
        const tradeDate =
          fillDate && fillDate >= i.executeDate && fillDate <= reportDay
            ? fillDate
            : datedOrder
              ? i.executeDate
              : null;
        if (!applySleeveFill(i, quantity, average, tradeDate, observedAt, db)) {
          accepted = false;
          r = unresolved();
        }
      }
    }
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
    if (
      accepted &&
      r.status !== "unknown_reconcile" &&
      i.side === "SELL" &&
      patch.filledQuantity &&
      patch.averageFillPrice
    ) {
      // Fees and net amounts are cumulative evidence for the reported quantity.
      const sameFill = r.filledQuantity === patch.filledQuantity;
      recordSellSettlement(
        { ...i, ...patch },
        getDeployment(i.deploymentId, db)!.market,
        sameFill ? r : {},
        db,
      );
    }
    if (
      accepted &&
      r.status !== "unknown_reconcile" &&
      patch.venueOrderId &&
      (patch.filledQuantity ?? 0) > 0
    ) {
      const arrival = arrivalEvidence(i.id, db)?.price ?? null;
      for (const fillId of fillIds)
        recordExecutionFillLink(
          {
            intentId: i.id,
            ...account,
            venueOrderId: patch.venueOrderId,
            fillId,
            arrivalPrice: arrival,
          },
          db,
        );
      if (
        !fillIds.length &&
        (patch.filledQuantity !== i.filledQuantity || r.status !== i.status)
      )
        appendExecutionAuditEvent(
          {
            deploymentId: i.deploymentId,
            runId: i.runId,
            intentId: i.id,
            eventType: "fill_identity_unavailable",
            details: {
              venueOrderId: patch.venueOrderId,
              filledQuantity: patch.filledQuantity,
              arrivalPrice: arrival,
            },
          },
          db,
        );
    }
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
  const now = input.deps?.now ?? Date.now;
  const windowClosed = () =>
    input.deps?.executionWindowCheck?.(now()) === false;
  if (windowClosed()) return "execution-window-closed";
  if (submissionDateExpired(i, now)) return "execute-date-expired";
  const reader = input.deps?.readQuote ?? createPipelineQuoteReader({ now });
  let quote: PipelineQuoteSnapshot | null = null;
  let readError: string | null = null;
  try {
    quote = reader.readChecked
      ? await reader.readChecked(
          i.symbol,
          input.executeDate,
          "venue" in i.venueBinding ? i.venueBinding.venue : undefined,
        )
      : await reader(i.symbol, input.executeDate);
  } catch (e) {
    readError =
      e instanceof ExecutionQuoteError ? e.message : "missing-execution-quote";
  }
  const timeError = () =>
    quote
      ? quoteTimeError(
          quote,
          input.executeDate,
          now(),
          i.venueKind === "local_sim",
        )
      : null;
  const decision =
    readError ?? timeError() ?? quoteDecision(i, quote, deployment);
  if (windowClosed()) return "execution-window-closed";
  const executePrice = typeof decision === "number" ? decision : null;
  const adapter = resolveVenueAdapter(i.venueBinding, input.deps);
  const externalBuy =
    executePrice !== null && i.phase === 2 && i.venueKind !== "local_sim";
  const orders = externalBuy ? listIntentsByRun(i.runId, db) : [];
  const sells = orders.filter((o) => o.phase === 1);
  const proceeds = sells.length
    ? sellProceeds(sells, deployment.market, db)
    : null;
  const coverage =
    proceeds &&
    (sells.some((o) => o.status !== "filled") ||
      proceeds.realized.lt(proceeds.expected))
      ? buyBalanceCoverage(orders, deployment, db)
      : null;
  const capSnapshot =
    i.side === "BUY" && executePrice !== null
      ? await readExecutionRiskSnapshot(
          i,
          deployment,
          executePrice,
          reader,
          adapter,
          now,
          db,
        )
      : null;
  const state = capSnapshot?.state;
  const cash: BuyCashSnapshot | null =
    coverage && state && Number.isFinite(state.cash) && state.cash >= 0
      ? { cash: state.cash, ...coverage }
      : null;
  const submissionBlock = () => {
    const current = getDeployment(i.deploymentId, db);
    if (!current) return "deployment-inactive";
    if (current.executionMode !== deployment.executionMode)
      return "execution-mode-changed";
    if (input.deps?.executionWindowCheck?.(now(), current) === false)
      return "execution-window-closed";
    if (submissionDateExpired(i, now)) return "execute-date-expired";
    return gate(current, [i], input.manualApproved, db);
  };
  // Take the SQLite writer lock before sampling the clock or inspecting phase
  // and cash. Publish the claim, reservation and arrival evidence together.
  const prepared = new AccountWorkspaceRepository(db).atomic(() => {
    const current = getIntent(i.id, db);
    if (!current || !pending(current)) return null;
    if (current.executeDate !== input.executeDate)
      return "execute-date-mismatch";
    const reason = submissionBlock();
    if (reason) return reason;
    const quoteError =
      timeError() ?? (typeof decision === "string" ? decision : null);
    if (executePrice === null || quoteError) {
      transitionIntentStatus(
        i.id,
        "rejected",
        { errorSummary: quoteError ?? "missing-execution-quote" },
        db,
      );
      return null;
    }
    if (
      current.phase === 2 &&
      listIntentsByRun(i.runId, db).some(
        (o) => o.phase === 1 && !isTerminalIntentStatus(o.status),
      )
    )
      return "pending-sell-phase";
    if (current.side === "SELL" && !canSubmitSleeveSell(current, db)) {
      transitionIntentStatus(
        i.id,
        "rejected",
        { errorSummary: "insufficient-sleeve-quantity" },
        db,
      );
      return null;
    }
    const affordable =
      current.phase === 2
        ? affordableBuy(
            current,
            executePrice,
            deployment,
            cash,
            db,
            adapter.cnBuyStep,
          )
        : current.quantity;
    const cap =
      affordable && current.side === "BUY"
        ? limitExecutionBuy(
            current,
            affordable,
            executePrice,
            getDeployment(i.deploymentId, db)!,
            capSnapshot,
            db,
            adapter.cnBuyStep,
          )
        : null;
    const quantity = cap?.quantity ?? affordable;
    if (!quantity) {
      transitionIntentStatus(
        i.id,
        "rejected",
        { errorSummary: cap?.reason ?? "insufficient-realized-proceeds" },
        db,
      );
      return null;
    }
    const updatedAt = now();
    drizzle(db)
      .update(orderEvidence)
      .set({ status: "submitting", quantity, updatedAt })
      .where(
        and(
          eq(orderEvidence.id, i.id),
          eq(orderEvidence.status, current.status),
        ),
      )
      .run();
    appendExecutionAuditEvent(
      {
        deploymentId: i.deploymentId,
        runId: i.runId,
        intentId: i.id,
        eventType: "intent_claimed",
        details: { from: current.status, to: "submitting" },
        createdAt: updatedAt,
      },
      db,
    );
    appendExecutionAuditEvent(
      {
        deploymentId: i.deploymentId,
        runId: i.runId,
        intentId: i.id,
        eventType: "execution_arrival",
        details: {
          arrivalPrice: executePrice,
          plannedQuantity: current.quantity,
          quantity,
          source: quote?.source ?? null,
          observedAt: quote?.observedAt ?? null,
        },
      },
      db,
    );
    return { intent: getIntent(i.id, db)!, price: executePrice };
  });
  if (!prepared || typeof prepared === "string") return prepared ?? undefined;
  const submission = prepared.intent;
  const beforeSend = () => {
    const current = getIntent(i.id, db);
    if (
      current?.status !== "submitting" ||
      current.updatedAt !== submission.updatedAt
    )
      return "intent-not-claimed";
    return (
      submissionBlock() ??
      timeError() ??
      (capSnapshot &&
      executionRiskFactsChanged(current, deployment, capSnapshot.facts, db)
        ? "execution-account-state-changed"
        : null) ??
      (current.side === "SELL" && !canSubmitSleeveSell(current, db)
        ? "insufficient-sleeve-quantity"
        : null)
    );
  };
  let response: VenueOrderResult;
  try {
    const reason = beforeSend();
    response = reason
      ? { ...unresolved(), status: "rejected", errorSummary: reason }
      : await adapter.submitOrder(submission, {
          executePrice: prepared.price,
          submissionBlock: beforeSend,
          executeDate: input.executeDate,
          db,
          ...(quote ? { quote } : {}),
        });
  } catch {
    response = unresolved();
  }
  applyResult(submission, response, db, now());
  if (
    response.status === "rejected" &&
    (response.errorSummary === "kill-switch-off" ||
      response.errorSummary === "stale-execution-quote" ||
      response.errorSummary === "live-kill-switch-off" ||
      response.errorSummary === "execute-date-expired" ||
      response.errorSummary === "execution-window-closed")
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
    if (
      reason === "kill-switch-off" ||
      reason === "live-kill-switch-off" ||
      reason === "execution-window-closed"
    )
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
  let intents = listIntentsByRun(run.id, db);
  const reason = gate(deployment, intents, input.manualApproved, db);
  if (reason) return stop(reason);
  if (onlyIntent && deployment.executionMode !== "manual_confirm")
    return skipped("manual-confirm-mode-required");
  if (input.executeDate !== run.executeDate)
    return skipped("execute-date-mismatch");
  if (deployment.market === "cn-equity" && intents.some(pending)) {
    const date = await settlePendingRunDate(
      run,
      deployment,
      db,
      input.deps?.now,
      input.deps?.executionCalendar,
    );
    if (date.reason) return skipped(date.reason);
    input = { ...input, executeDate: date.executeDate };
    intents = listIntentsByRun(run.id, db);
  }
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
// Keep timed-out transports in the in-flight set until they actually settle.
// A second tick can submit orders immediately and use any spare polling slots.
const reconciliationLanes = new WeakMap<
  Db,
  { active: Set<string>; cursor: string }
>();
const reconciliationConcurrency = 4;
const reconciliationDeadlineMs = 2_000;
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
  let lane = reconciliationLanes.get(db);
  if (!lane) {
    lane = { active: new Set(), cursor: "" };
    reconciliationLanes.set(db, lane);
  }
  const { active, cursor } = lane;
  const capacity = reconciliationConcurrency - active.size;
  if (capacity <= 0) return { queried: 0 };
  const eligible = and(
    inArray(orderEvidence.status, [...reconciliationStatuses]),
    or(
      ne(orderEvidence.status, "submitting"),
      lte(orderEvidence.updatedAt, submittingCutoff),
    ),
    input.runId === undefined
      ? undefined
      : eq(orderEvidence.runId, input.runId),
    input.deploymentId === undefined
      ? undefined
      : eq(orderEvidence.deploymentId, input.deploymentId),
    input.executeDate === undefined
      ? undefined
      : eq(orderEvidence.executeDate, input.executeDate),
    active.size ? notInArray(orderEvidence.id, [...active]) : undefined,
  );
  const page = (wrap: boolean, limit: number) =>
    drizzle(db)
      .select({ id: orderEvidence.id })
      .from(orderEvidence)
      .where(
        and(
          eligible,
          wrap ? lte(orderEvidence.id, cursor) : gt(orderEvidence.id, cursor),
        ),
      )
      .orderBy(orderEvidence.id)
      .limit(limit)
      .all();
  const batch = page(false, capacity);
  if (cursor && batch.length < capacity)
    batch.push(...page(true, capacity - batch.length));
  if (!batch.length) return { queried: 0 };
  lane.cursor = batch.at(-1)!.id;
  let queried = 0;
  const polls = batch.map(async ({ id }) => {
    active.add(id);
    try {
      const i = getIntent(id, db)!;
      const evidence =
        i.venueKind === "crypto_live"
          ? observeFillDates(input.deps?.fetchImpl ?? fetch)
          : null;
      let response: VenueOrderResult;
      try {
        response = await resolveVenueAdapter(
          i.venueBinding,
          evidence ? { ...input.deps, fetchImpl: evidence.read } : input.deps,
        ).reconcileOrder(i, { db });
      } catch {
        response = unresolved();
      }
      if (!db.open) return;
      applyResult(
        i,
        response,
        db,
        input.deps?.now?.() ?? Date.now(),
        evidence?.firstDate(response.fillIds ?? []) ?? null,
      );
      refreshStage(i.runId, db);
      queried++;
    } finally {
      active.delete(id);
    }
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(polls),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, reconciliationDeadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return { queried };
}
