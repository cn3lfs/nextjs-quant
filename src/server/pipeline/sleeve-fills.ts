import { sleeveFillCheckpoint } from "../execution/pipeline-proceeds";
import Big from "big.js";
import type Database from "better-sqlite3";
import type { VenueBinding } from "trading-strategies";
import { normalizePoolSymbol } from "../db/pool-repository";
import { planningAccount } from "./account-coordinator";
import {
  appendExecutionAuditEvent,
  type OrderIntentRecord,
} from "../db/pipeline-repository";
import {
  listOwnerSleeveHoldings,
  syncSleeveHoldingDelta,
  upsertSleeveHolding,
} from "../db/sleeve-holding-repository";

type Db = Database.Database;
type Intent = OrderIntentRecord;

export function fillAccount(binding: VenueBinding) {
  const account = planningAccount(binding);
  switch (binding.kind) {
    case "local_sim":
      return { ...account, fillSource: "sim_fills" } as const;
    case "ths_mock":
      return { ...account, fillSource: "ths_mock" } as const;
    case "crypto_sim":
      return { ...account, fillSource: "crypto_sim" } as const;
    default:
      return { ...account, fillSource: "real_fills" } as const;
  }
}

function sleeveKey(i: Intent) {
  return {
    ...planningAccount(i.venueBinding),
    ownerKind: "deployment",
    ownerId: i.deploymentId,
    symbol: normalizePoolSymbol(i.symbol),
  } as const;
}

export function ownedHolding(i: Intent, db: Db) {
  const key = sleeveKey(i);
  return listOwnerSleeveHoldings(key, db).find(
    (holding) => normalizePoolSymbol(holding.symbol) === key.symbol,
  );
}
// Older executors persisted confirmed partials without a sleeve checkpoint.
// Keep that prefix separate from new fills, even if the next poll is inconclusive.
export function preserveHistoricPartial(i: Intent, db: Db) {
  if (
    i.status !== "partial_filled" ||
    !i.filledQuantity ||
    !i.averageFillPrice ||
    sleeveFillCheckpoint(i.id, db)
  )
    return;
  appendExecutionAuditEvent(
    {
      deploymentId: i.deploymentId,
      runId: i.runId,
      intentId: i.id,
      eventType: "sleeve_fill_delta",
      details: {
        filledQuantity: i.filledQuantity,
        averageFillPrice: i.averageFillPrice,
        quantityDelta: 0,
        unattributedQuantity: i.filledQuantity,
        reason: "historic-partial-before-sleeve-accounting",
      },
    },
    db,
  );
}

/** Called inside the same writer transaction as the fill links and intent status. */
export function applySleeveFill(
  i: Intent,
  quantity: number,
  average: number,
  tradeDate: string | null,
  observedAt: number,
  db: Db,
) {
  const prior = sleeveFillCheckpoint(i.id, db);
  const delta = new Big(quantity).minus(prior?.quantity ?? 0);
  if (delta.eq(0)) return prior?.average === average;
  const turnover = new Big(quantity)
    .times(average)
    .minus(new Big(prior?.quantity ?? 0).times(prior?.average ?? 0));
  if (delta.lt(0) || turnover.lte(0)) return false;
  const price = turnover.div(delta).toNumber();
  if (!Number.isFinite(price) || price <= 0) return false;
  // A pre-v26 sell may have reached the venue without any ownership check.
  // Preserve its actual fill and expose the part with no attributable inventory.
  const holding = ownedHolding(i, db);
  const signed =
    i.side === "BUY"
      ? delta
      : new Big(Math.min(delta.toNumber(), holding?.quantity ?? 0)).times(-1);
  if (signed.gt(0) && !holding?.quantity && !tradeDate) {
    upsertSleeveHolding(
      {
        ...sleeveKey(i),
        quantity: signed.toNumber(),
        avgEntryPrice: price,
        entryDate: null,
        reservedCash: holding?.reservedCash ?? 0,
        updatedAt: observedAt,
      },
      db,
    );
  } else if (!signed.eq(0)) {
    syncSleeveHoldingDelta(
      {
        ...sleeveKey(i),
        quantityDelta: signed.toNumber(),
        fillPrice: price,
        // Only opening a position uses this date; an undated opening is handled above.
        tradeDate: tradeDate ?? i.executeDate,
        updatedAt: observedAt,
      },
      db,
    );
  }
  appendExecutionAuditEvent(
    {
      deploymentId: i.deploymentId,
      runId: i.runId,
      intentId: i.id,
      eventType: "sleeve_fill_delta",
      details: {
        filledQuantity: quantity,
        averageFillPrice: average,
        fillPrice: price,
        quantityDelta: signed.toNumber(),
        unattributedQuantity: delta.minus(signed.abs()).toNumber(),
        tradeDate,
      },
    },
    db,
  );
  return true;
}
