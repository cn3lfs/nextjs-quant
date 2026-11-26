import Big from "big.js";
import { resolveInstrumentRule } from "quant-execution";
import type Database from "better-sqlite3";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import {
  listIntentsByRun,
  appendExecutionAuditEvent,
  type OrderIntentRecord,
} from "../db/pipeline-repository";
import type { DeploymentRecord } from "../db/deployment-repository";
import { SimAccountRepository } from "../db/sim-account-repository";
import { moneyDigits, quantityDigits } from "../portfolio/sim-accounts/engine";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

type Intent = OrderIntentRecord;
type Db = Database.Database;
type Market = DeploymentRecord["market"];
const min = (a: Big, b: Big) => (a.lt(b) ? a : b);

function cashValue(i: Intent, quantity: number, price: number, market: Market) {
  return settlementValue(i, new Big(price).times(quantity), market);
}

function settlementValue(i: Intent, turnover: Big, market: Market) {
  if (turnover.eq(0)) return new Big(0);
  const digits = moneyDigits(market);
  const round = (value: Big) => value.round(digits, Big.roundHalfUp);
  const gross = round(turnover);
  const fixed = researchExecutionCosts(market, "fixed");
  const costs =
    market === "crypto"
      ? fixed
      : executionCostsForInstrument(fixed, i.symbol, i.executeDate);
  const bps = (rate: number) => round(gross.times(rate).div(10000));
  const commission = bps(costs.commissionBps);
  const fees = (
    commission.lt(costs.minimumCommission)
      ? new Big(costs.minimumCommission)
      : commission
  )
    .plus(bps(costs.transferBps ?? 0))
    .plus(bps(costs.slippageBps));
  return i.side === "BUY"
    ? gross.plus(fees)
    : gross.minus(fees).minus(bps(costs.sellTaxBps));
}

type Settlement = {
  filledQuantity: number;
  averageFillPrice: number;
  netProceeds: number;
  feeBasis: "actual" | "estimated";
};
const audit = sqliteTable("execution_audit_events", {
  id: integer("id").primaryKey(),
  intentId: text("intent_id"),
  runId: text("run_id"),
  kind: text("event_type").notNull(),
  details: text("details_json", { mode: "json" }).notNull(),
});
type ExecutionEvidence = {
  sell_settlement: Settlement;
  execution_arrival: { arrivalPrice: number; plannedQuantity: number };
  sleeve_fill_delta: { filledQuantity: number; averageFillPrice: number };
  buy_cash_after_sell: BuyCashSnapshot;
};
function evidence<K extends keyof ExecutionEvidence>(
  kind: K,
  id: string,
  db: Db,
): ExecutionEvidence[K] | undefined {
  const first = kind === "buy_cash_after_sell";
  const row = drizzle(db)
    .select({ details: audit.details })
    .from(audit)
    .where(
      and(eq(audit.kind, kind), eq(first ? audit.runId : audit.intentId, id)),
    )
    .orderBy(first ? asc(audit.id) : desc(audit.id))
    .limit(1)
    .get();
  return row?.details as ExecutionEvidence[K] | undefined;
}
export function sleeveFillCheckpoint(id: string, db: Db) {
  const row = evidence("sleeve_fill_delta", id, db);
  return row && { quantity: row.filledQuantity, average: row.averageFillPrice };
}
function settlement(i: Intent, db: Db) {
  const value = evidence("sell_settlement", i.id, db);
  return value &&
    value.filledQuantity === i.filledQuantity &&
    value.averageFillPrice === i.averageFillPrice
    ? value
    : null;
}

export function recordSellSettlement(
  i: Intent,
  market: Market,
  report: { fee?: number; netProceeds?: number; grossWithoutFee?: number },
  db: Db,
) {
  if (i.side !== "SELL" || !i.averageFillPrice || !i.filledQuantity) return;
  const previous = settlement(i, db);
  const { fee, netProceeds, grossWithoutFee } = report;
  const actual =
    netProceeds !== undefined || (fee !== undefined && !grossWithoutFee);
  if (!actual && previous?.feeBasis === "actual") return;

  const gross = new Big(i.averageFillPrice).times(i.filledQuantity);
  const estimated = cashValue(i, i.filledQuantity, i.averageFillPrice, market);
  // If only some executions have fees, allocate the estimated order fee
  // to the unpriced share of turnover and keep the reported remainder.
  const missingFee = grossWithoutFee
    ? gross
        .minus(estimated)
        .times(grossWithoutFee)
        .div(gross)
        .round(moneyDigits(market))
    : new Big(0);
  const value =
    netProceeds ??
    (fee === undefined
      ? estimated
      : gross.minus(fee).minus(missingFee)
    ).toNumber();
  const feeBasis = actual ? "actual" : "estimated";
  if (previous?.feeBasis === feeBasis && previous.netProceeds === value) return;
  appendExecutionAuditEvent(
    {
      deploymentId: i.deploymentId,
      runId: i.runId,
      intentId: i.id,
      eventType: "sell_settlement",
      details: {
        filledQuantity: i.filledQuantity,
        averageFillPrice: i.averageFillPrice,
        feeBasis,
        netProceeds: value,
        ...(fee === undefined ? {} : { fee }),
        ...(grossWithoutFee
          ? { grossWithoutFee, estimatedFee: missingFee.toNumber() }
          : {}),
      },
    },
    db,
  );
}

export function sellProceeds(sells: Intent[], market: Market, db: Db) {
  let expected = new Big(0),
    realized = new Big(0);
  for (const i of sells) {
    expected = expected.plus(
      cashValue(i, i.quantity, i.referencePrice, market),
    );
    if (i.averageFillPrice && i.filledQuantity)
      realized = realized.plus(
        settlement(i, db)?.netProceeds ??
          cashValue(i, i.filledQuantity, i.averageFillPrice, market),
      );
  }
  return { expected, realized };
}

export function arrivalEvidence(id: string, db: Db) {
  const row = evidence("execution_arrival", id, db);
  return row && { price: row.arrivalPrice, planned: row.plannedQuantity };
}

export type BuyCashSnapshot = {
  cash: number;
  coveredFills: Record<string, number>;
  coveredCommitments?: Record<string, number>;
};

function buyCommitment(
  buy: Intent,
  dep: DeploymentRecord,
  db: Db,
  arrival?: number,
) {
  const filled = buy.filledQuantity ?? 0;
  const bound =
    arrival ??
    new Big(buy.referencePrice)
      .times(new Big(1).plus(dep.riskPolicy.maxGapPct))
      .toNumber();
  const spent = new Big(filled).times(buy.averageFillPrice ?? bound);
  const leaves = ["filled", "rejected", "cancelled"].includes(buy.status)
    ? new Big(0)
    : new Big(buy.quantity).minus(filled);
  let turnover = spent.plus(leaves.times(bound));
  if (buy.status === "unknown_reconcile") {
    const known = sleeveFillCheckpoint(buy.id, db);
    const verifiedSpend = new Big(known?.quantity ?? 0).times(
      known?.average ?? 0,
    );
    const floor = verifiedSpend.plus(
      new Big(buy.quantity).minus(known?.quantity ?? 0).times(bound),
    );
    if (turnover.lt(floor)) turnover = floor;
  }
  // The filled and frozen portions belong to one order with one minimum commission.
  return settlementValue(buy, turnover, dep.market);
}

// Capture only what was acknowledged BEFORE awaiting the free-cash balance.
// An unacknowledged submission has no evidence that the venue froze its leaves.
export function buyBalanceCoverage(
  orders: Intent[],
  dep: DeploymentRecord,
  db: Db,
) {
  const coveredFills: Record<string, number> = {};
  const coveredCommitments: Record<string, number> = {};
  for (const o of orders) {
    if (o.phase !== 2 || o.status === "submitting") continue;
    if (o.status === "unknown_reconcile") {
      const known = sleeveFillCheckpoint(o.id, db);
      if (known)
        coveredFills[o.id] = cashValue(
          o,
          known.quantity,
          known.average,
          dep.market,
        ).toNumber();
      continue;
    }
    if (o.filledQuantity && o.averageFillPrice)
      coveredFills[o.id] = cashValue(
        o,
        o.filledQuantity,
        o.averageFillPrice,
        dep.market,
      ).toNumber();
    if (
      o.venueOrderId &&
      (o.status === "submitted" || o.status === "partial_filled")
    ) {
      coveredCommitments[o.id] = buyCommitment(
        o,
        dep,
        db,
        arrivalEvidence(o.id, db)?.price,
      ).toNumber();
    }
  }
  return {
    coveredFills,
    ...(Object.keys(coveredCommitments).length && { coveredCommitments }),
  };
}

/** Called inside the submission preparation transaction. Reservations survive restarts and manual approvals. */
export function affordableBuy(
  i: Intent,
  price: number,
  dep: DeploymentRecord,
  available: BuyCashSnapshot | null,
  db: Db,
  venueStep?: number,
) {
  const orders = listIntentsByRun(i.runId, db);
  const sells = orders.filter((o) => o.phase === 1);
  const market = dep.market;
  const rule =
    market === "cn-equity"
      ? resolveInstrumentRule(i.symbol, i.executeDate)
      : null;
  const step = rule
    ? new Big(Math.max(rule.buyQuantityStep, venueStep ?? 1))
    : new Big(10).pow(-quantityDigits(market));
  const minimum = rule ? new Big(rule.minimumBuyQuantity) : step;
  if (minimum.gt(i.quantity)) return 0;
  const planned = minimum
    .plus(new Big(i.quantity).minus(minimum).div(step).round(0, 0).times(step))
    .toNumber();
  if (!sells.length) return planned;
  const { expected, realized } = sellProceeds(sells, market, db);
  const local =
    i.venueBinding.kind === "local_sim" ? i.venueBinding.simAccountId : null;
  if (
    !local &&
    realized.gte(expected) &&
    sells.every((o) => o.status === "filled")
  )
    return planned;
  const repo = new SimAccountRepository(db);
  let budget = new Big(0),
    reserved = new Big(0);
  const firstRow = local
    ? undefined
    : evidence("buy_cash_after_sell", i.runId, db);
  const first = firstRow ?? available;
  if (!firstRow && available)
    appendExecutionAuditEvent(
      {
        deploymentId: i.deploymentId,
        runId: i.runId,
        eventType: "buy_cash_after_sell",
        details: available,
      },
      db,
    );
  let firstReserved = new Big(0),
    currentReserved = new Big(0);
  for (const buy of orders.filter((o) => o.phase === 2)) {
    const evidence = arrivalEvidence(buy.id, db);
    budget = budget.plus(
      cashValue(
        buy,
        evidence?.planned ?? buy.quantity,
        buy.referencePrice,
        market,
      ),
    );
    if (buy.id === i.id || buy.status === "planned" || buy.status === "queued")
      continue;
    // The local ledger already subtracted settled orders. Only in-flight submissions need reserving.
    if (local && repo.orderByRequest(local, "pipeline:" + buy.idempotencyKey))
      continue;
    const commitment = buyCommitment(buy, dep, db, evidence?.price);
    reserved = reserved.plus(commitment);
    const uncovered = (snapshot: BuyCashSnapshot | null) =>
      commitment.minus(
        min(
          commitment,
          new Big(
            snapshot?.coveredCommitments?.[buy.id] ??
              snapshot?.coveredFills?.[buy.id] ??
              0,
          ),
        ),
      );
    firstReserved = firstReserved.plus(uncovered(first));
    currentReserved = currentReserved.plus(uncovered(available));
  }
  const cash = local
    ? new Big(repo.account(local).cash_atoms.toString())
        .div(new Big(10).pow(moneyDigits(market)))
        .minus(reserved)
    : budget.minus(expected.minus(realized)).minus(reserved);
  let limit = cash;
  if (first) limit = min(limit, new Big(first.cash).minus(firstReserved));
  if (available)
    limit = min(limit, new Big(available.cash).minus(currentReserved));
  const cost = (qty: number) => cashValue(i, qty, price, market);
  if (cost(minimum.toNumber()).gt(limit)) return 0;
  let lo = 0n,
    hi = BigInt(
      new Big(i.quantity).minus(minimum).div(step).round(0, 0).toFixed(),
    );
  const orderQty = (steps: bigint) =>
    minimum.plus(step.times(steps.toString())).toNumber();
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (cost(orderQty(mid)).lte(limit)) lo = mid;
    else hi = mid - 1n;
  }
  const quantity = orderQty(lo);
  if (quantity !== i.quantity)
    appendExecutionAuditEvent(
      {
        deploymentId: i.deploymentId,
        runId: i.runId,
        intentId: i.id,
        eventType: "buy_quantity_resized_after_sell",
        details: {
          plannedQuantity: i.quantity,
          quantity,
          availableCash: limit.toNumber(),
          expectedSellProceeds: expected.toNumber(),
          realizedSellProceeds: realized.toNumber(),
        },
      },
      db,
    );
  return quantity;
}
