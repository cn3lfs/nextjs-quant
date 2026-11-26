import type Database from "better-sqlite3";
import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { resolveInstrumentRule } from "quant-execution";
import {
  extractVenueAccountKey,
  isTerminalIntentStatus,
  orderIntentStatuses,
  type OrderIntentStatus,
  type VenueBinding,
} from "trading-strategies";
import { z } from "zod";
import { big, bigMin } from "trading-strategy-core/money";
import {
  accountKeySchema,
  type AccountKey,
} from "../db/account-risk-state-repository";
import {
  appendExecutionAuditEvent,
  type PipelineRunRecord,
} from "../db/pipeline-repository";
import type { DeploymentRecord } from "../db/deployment-repository";
import { normalizePoolSymbol } from "../db/pool-repository";
import { RpsStore } from "../db/rps-store";
import {
  listAccountSleeveHoldings,
  type SleeveHolding,
} from "../db/sleeve-holding-repository";
import { sleeveFillCheckpoint } from "../execution/pipeline-proceeds";
import { settlementDate } from "../portfolio/sim-accounts/engine";
import type { PipelineAccountState } from "./signal-risk-runner";

export function planningAccount(binding: VenueBinding): AccountKey {
  switch (binding.kind) {
    case "local_sim":
      return { accountScope: binding.kind, accountId: binding.simAccountId };
    case "ths_mock":
      return { accountScope: binding.kind, accountId: binding.accountTag };
    case "crypto_sim":
      return {
        accountScope: binding.kind,
        accountId: extractVenueAccountKey(binding),
      };
    default:
      return {
        accountScope: "real",
        accountId: extractVenueAccountKey(binding),
      };
  }
}

function matchesAccount(column: SQLWrapper, binding: VenueBinding) {
  const field = (path: string, value: string) =>
    eq(sql<string>`json_extract(${column}, ${path})`, value);
  const kind = field("$.kind", binding.kind);
  switch (binding.kind) {
    case "local_sim":
      return and(kind, field("$.simAccountId", binding.simAccountId));
    case "ths_mock":
      return and(kind, field("$.accountTag", binding.accountTag));
    case "cn_broker_live":
      return and(
        kind,
        field("$.broker", binding.broker),
        field("$.accountId", binding.accountId),
      );
    default:
      return and(
        kind,
        field("$.venue", binding.venue),
        field("$.accountId", binding.accountId),
      );
  }
}

type Commitment = {
  id: string;
  deploymentId: string;
  executeDate: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  referencePrice: number;
  status: OrderIntentStatus;
  filledQuantity: number;
  updatedAt: number;
  maxGapPct: number;
};

const liveStatuses = orderIntentStatuses.filter(
  (status) => !isTerminalIntentStatus(status),
);

// Read-only projections of the execution facts needed while publishing account risk.
const orders = sqliteTable("execution_order_intents", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  deploymentId: text("deployment_id").notNull(),
  decisionDate: text("decision_date").notNull(),
  executeDate: text("execute_date").notNull(),
  venueKind: text("venue_kind").notNull(),
  binding: text("venue_binding_json").notNull(),
  symbol: text("symbol").notNull(),
  side: text("side").$type<"BUY" | "SELL">().notNull(),
  quantity: real("quantity").notNull(),
  referencePrice: real("reference_price").notNull(),
  status: text("status").$type<OrderIntentStatus>().notNull(),
  filled: real("filled_quantity"),
  updatedAt: integer("updated_at").notNull(),
});
const runs = sqliteTable("pipeline_runs", {
  id: text("id").primaryKey(),
  verdict: text("risk_verdict_json"),
});
const deployments = sqliteTable("strategy_deployments", {
  id: text("id").primaryKey(),
  policy: text("risk_policy_json").notNull(),
  binding: text("venue_binding_json").notNull(),
  status: text("status").notNull(),
});
const simAccounts = sqliteTable("sim_accounts", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
});
const audit = sqliteTable("execution_audit_events", {
  id: integer("id").primaryKey(),
  deploymentId: text("deployment_id").notNull(),
  runId: text("run_id"),
  intentId: text("intent_id"),
  type: text("event_type").notNull(),
  details: text("details_json").notNull(),
  createdAt: integer("created_at").notNull(),
});
export function planningCalendarWarning(runId: string, db: Database.Database) {
  return drizzle(db)
    .select({
      warning: sql<string>`json_extract(${audit.details},'$.warning')`,
    })
    .from(audit)
    .where(
      and(
        eq(audit.runId, runId),
        eq(audit.type, "execution_calendar_fallback"),
      ),
    )
    .limit(1)
    .get()?.warning;
}

// A live sleeve row can be overwritten or deleted completely by its next fill.
const planningSleevesSchema = z.array(
  z.object({
    ownerKind: z.enum(["deployment", "manual", "legacy_unknown"]),
    ownerId: z.string(),
    symbol: z.string(),
    quantity: z.number().finite().positive(),
    unsettledQuantity: z.number().finite().nonnegative(),
  }),
);
const frozenInventorySchema = accountKeySchema.extend({
  sleeves: planningSleevesSchema,
});
type PlanningSleeves = z.infer<typeof planningSleevesSchema>;

/** Called inside the run creation transaction. Resumed stages use the original
 * inventory while outstanding reservations and shared limits stay live. */
export function freezePlanningSleeves(
  deployment: DeploymentRecord,
  run: PipelineRunRecord,
  db: Database.Database,
  created: boolean,
): PlanningSleeves {
  const account = planningAccount(deployment.venueBinding);
  const saved = drizzle(db)
    .select({ payload: audit.details })
    .from(audit)
    .where(
      and(
        eq(audit.deploymentId, deployment.id),
        eq(audit.runId, run.id),
        eq(audit.type, "planning_sleeves_frozen"),
      ),
    )
    .get();
  if (saved) {
    const inventory = frozenInventorySchema.parse(JSON.parse(saved.payload));
    if (
      inventory.accountScope !== account.accountScope ||
      inventory.accountId !== account.accountId
    )
      throw new Error("运行冻结的分仓账户与当前部署不一致");
    return inventory.sleeves;
  }
  const { commitments } = readPlanningFacts(
    deployment,
    run.decisionDate,
    run.executeDate,
    db,
    run.startedAt,
    [],
  );
  const sleeves = readSleevesAsOf(
    deployment,
    run.decisionDate,
    settlementDate(deployment.market, run.executeDate),
    run.startedAt,
    commitments,
    db,
    !created,
  );
  appendExecutionAuditEvent(
    {
      deploymentId: deployment.id,
      runId: run.id,
      eventType: "planning_sleeves_frozen",
      details: { ...account, sleeves },
    },
    db,
  );
  return sleeves;
}

type SleeveBalance = Pick<
  SleeveHolding,
  "ownerKind" | "ownerId" | "symbol" | "quantity" | "entryDate" | "updatedAt"
>;

/** Before runs carried a frozen inventory, an overwritten balance could only
 * be recovered from the signed, attributed fill prefix for this account. */
function recoverAuditedSleeves(
  deployment: DeploymentRecord,
  cutoff: number,
  decisionDate: string,
  balances: SleeveBalance[],
  db: Database.Database,
) {
  const key = (owner: string, symbol: string) =>
    JSON.stringify([owner, normalizePoolSymbol(symbol)]);
  const known = new Set(
    balances
      .filter((s) => s.ownerKind === "deployment")
      .map((s) => key(s.ownerId, s.symbol)),
  );
  const recovered = new Map<string, SleeveBalance>();
  const fills = drizzle(db)
    .select({
      ownerId: orders.deploymentId,
      symbol: orders.symbol,
      at: audit.createdAt,
      quantity: sql<number>`json_extract(${audit.details},'$.quantityDelta')`,
      day: sql<string | null>`json_extract(${audit.details},'$.tradeDate')`,
    })
    .from(orders)
    .innerJoin(audit, eq(audit.intentId, orders.id))
    .where(
      and(
        eq(orders.venueKind, deployment.venueBinding.kind),
        matchesAccount(orders.binding, deployment.venueBinding),
        eq(audit.type, "sleeve_fill_delta"),
        lte(audit.createdAt, cutoff),
      ),
    )
    .orderBy(audit.createdAt, audit.id)
    .all();
  for (const fill of fills) {
    const id = key(fill.ownerId, fill.symbol);
    if (
      known.has(id) ||
      !fill.quantity ||
      (fill.day && fill.day > decisionDate)
    )
      continue;
    const prior = recovered.get(id);
    const quantity = big(prior?.quantity ?? 0).plus(fill.quantity);
    if (quantity.lte(0)) recovered.delete(id);
    else
      recovered.set(id, {
        ownerKind: "deployment",
        ownerId: fill.ownerId,
        symbol: fill.symbol,
        quantity: quantity.toNumber(),
        entryDate: prior ? prior.entryDate : fill.day,
        updatedAt: fill.at,
      });
  }
  return [...balances, ...recovered.values()];
}

function readSleevesAsOf(
  deployment: DeploymentRecord,
  decisionDate: string,
  day: string,
  asOfCreatedAt: number,
  commitments: Commitment[],
  db: Database.Database,
  recoverHistory = false,
): PlanningSleeves {
  const account = planningAccount(deployment.venueBinding);
  const zone = deployment.market === "cn-equity" ? "+08:00" : "Z";
  const cutoff = Math.min(
    asOfCreatedAt,
    Date.parse(decisionDate + "T23:59:59.999" + zone),
  );
  // A delayed receipt can have a different trade date from the scheduled intent.
  // Keep the matched IDs even for older fills to avoid also counting a scheduled-day fallback.
  const tradeDate = sql<
    string | null
  >`json_extract(${audit.details},'$.tradeDate')`;
  const fillDeltas =
    day > decisionDate || deployment.market !== "cn-equity"
      ? []
      : drizzle(db)
          .select({
            intentId: orders.id,
            symbol: orders.symbol,
            tradeDate,
            createdAt: audit.createdAt,
            quantity: sql<number>`json_extract(${audit.details},'$.quantityDelta')`,
          })
          .from(orders)
          .innerJoin(audit, eq(audit.intentId, orders.id))
          .where(
            and(
              eq(orders.venueKind, deployment.venueBinding.kind),
              matchesAccount(orders.binding, deployment.venueBinding),
              eq(orders.deploymentId, deployment.id),
              eq(orders.side, "BUY"),
              eq(audit.type, "sleeve_fill_delta"),
              lte(audit.createdAt, cutoff),
              or(
                eq(orders.executeDate, day),
                eq(tradeDate, day),
                and(
                  isNull(tradeDate),
                  sql`${audit.createdAt} >= ${Date.parse(day + "T00:00:00" + zone)}`,
                ),
              ),
            ),
          )
          .orderBy(orders.id, audit.createdAt)
          .all();

  const knownBalances = listAccountSleeveHoldings(account, db).filter(
    (row) =>
      row.quantity > 0 &&
      row.updatedAt <= cutoff &&
      (row.entryDate === null || row.entryDate <= decisionDate),
  );
  const balances =
    recoverHistory || cutoff < asOfCreatedAt
      ? recoverAuditedSleeves(
          deployment,
          cutoff,
          decisionDate,
          knownBalances,
          db,
        )
      : knownBalances;
  return balances.map((sleeve) => ({
    ownerKind: sleeve.ownerKind,
    ownerId: sleeve.ownerId,
    symbol: sleeve.symbol,
    quantity: sleeve.quantity,
    unsettledQuantity: unsettledQuantity(sleeve),
  }));

  function unsettledQuantity(sleeve: SleeveBalance) {
    const symbol = normalizePoolSymbol(sleeve.symbol);
    if (
      sleeve.ownerKind !== "deployment" ||
      sleeve.ownerId !== deployment.id ||
      deployment.market !== "cn-equity" ||
      day > decisionDate ||
      resolveInstrumentRule(symbol, day).settlementDays === 0
    )
      return 0;
    // The first lot date alone cannot prove that a later top-up has settled.
    const actual = fillDeltas.filter(
      (fill) => normalizePoolSymbol(fill.symbol) === symbol,
    );
    const settledIntentIds = new Set(actual.map((fill) => fill.intentId));
    const dayStart = Date.parse(day + "T00:00:00+08:00");
    const actualBuys = actual
      .filter(
        (fill) =>
          fill.tradeDate === day ||
          (fill.tradeDate === null && fill.createdAt >= dayStart),
      )
      .reduce((sum, fill) => sum.plus(fill.quantity), big(0));
    const boughtToday = commitments
      .filter(
        (i) =>
          i.deploymentId === deployment.id &&
          normalizePoolSymbol(i.symbol) === symbol &&
          i.side === "BUY" &&
          i.executeDate === day &&
          i.updatedAt <= cutoff &&
          !settledIntentIds.has(i.id),
      )
      .reduce((sum, i) => sum.plus(i.filledQuantity), actualBuys);
    return (
      sleeve.entryDate === null
        ? sleeve.updatedAt >= dayStart
        : sleeve.entryDate >= day
    )
      ? sleeve.quantity
      : boughtToday.toNumber();
  }
}

/** Use the binding frozen on the intent even if its deployment is later rebound. */
export function readPlanningFacts(
  deployment: DeploymentRecord,
  decisionDate: string,
  executeDate: string,
  db: Database.Database,
  asOfCreatedAt = Date.now(),
  frozenSleeves?: PlanningSleeves,
) {
  const account = planningAccount(deployment.venueBinding);
  const day = settlementDate(deployment.market, executeDate);
  return drizzle(db).transaction((store) => {
    const binding = deployment.venueBinding;
    const accountCaps = store
      .select({
        symbol: sql<
          number | null
        >`min(json_extract(${deployments.policy}, '$.maxSymbolWeight'))`,
        total: sql<
          number | null
        >`min(json_extract(${deployments.policy}, '$.maxTotalExposure'))`,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.status, "active"),
          matchesAccount(deployments.binding, binding),
        ),
      )
      .get();
    const bound = and(
      eq(orders.venueKind, binding.kind),
      matchesAccount(orders.binding, binding),
    );
    const commitments: Commitment[] = store
      .select({
        id: orders.id,
        deploymentId: orders.deploymentId,
        executeDate: orders.executeDate,
        symbol: orders.symbol,
        side: orders.side,
        quantity: orders.quantity,
        referencePrice: orders.referencePrice,
        status: orders.status,
        updatedAt: orders.updatedAt,
        filledQuantity: sql<number>`coalesce(${orders.filled},0)`,
        maxGapPct: sql<number>`coalesce(json_extract(${runs.verdict},'$.maxGapPct'), json_extract(${deployments.policy},'$.maxGapPct'))`,
      })
      .from(orders)
      .innerJoin(runs, eq(runs.id, orders.runId))
      .innerJoin(deployments, eq(deployments.id, orders.deploymentId))
      .where(
        and(
          bound,
          or(
            inArray(orders.status, liveStatuses),
            and(
              lte(orders.decisionDate, decisionDate),
              eq(orders.executeDate, day),
              gt(orders.filled, 0),
            ),
          ),
        ),
      )
      .orderBy(orders.id)
      .all()
      .map((order) => ({
        ...order,
        // An inconclusive receipt can carry an unpriced, unverified quantity.
        // Only booked fills release the account's remaining reservation.
        filledQuantity:
          order.status === "unknown_reconcile"
            ? (sleeveFillCheckpoint(order.id, db)?.quantity ?? 0)
            : order.filledQuantity,
      }));
    const revision =
      account.accountScope === "local_sim"
        ? store
            .select({ revision: simAccounts.revision })
            .from(simAccounts)
            .where(eq(simAccounts.id, account.accountId))
            .get()?.revision
        : undefined;
    const sleeves =
      frozenSleeves ??
      readSleevesAsOf(
        deployment,
        decisionDate,
        day,
        asOfCreatedAt,
        commitments,
        db,
      );
    const ownedSleeves = sleeves.filter(
      (row) => row.ownerKind === "deployment" && row.ownerId === deployment.id,
    );
    return {
      sleeves,
      ownedSleeves,
      accountCaps,
      decisionDate,
      commitments,
      revision,
    };
  });
}
export type PlanningFacts = ReturnType<typeof readPlanningFacts>;

export function ownedPlanningPositions(
  deployment: DeploymentRecord,
  state: PipelineAccountState,
  facts: PlanningFacts,
) {
  const physical = new Map(
    (state.positions ?? []).map((p) => [normalizePoolSymbol(p.symbol), p]),
  );
  const result = [];
  const foreign = new Map<string, ReturnType<typeof big>>();
  for (const row of facts.sleeves) {
    if (row.ownerKind === "deployment" && row.ownerId === deployment.id)
      continue;
    const symbol = normalizePoolSymbol(row.symbol);
    foreign.set(symbol, (foreign.get(symbol) ?? big(0)).plus(row.quantity));
  }
  for (const sleeve of facts.ownedSleeves) {
    const symbol = normalizePoolSymbol(sleeve.symbol);
    const position = physical.get(symbol);
    if (
      !position ||
      !Number.isFinite(position.quantity) ||
      position.quantity <= 0
    )
      continue;
    const quantity = Math.min(position.quantity, sleeve.quantity);
    const settled = big(quantity).minus(sleeve.unsettledQuantity);
    let ownerPending = big(0),
      accountPending = big(0);
    for (const i of facts.commitments) {
      if (
        normalizePoolSymbol(i.symbol) !== symbol ||
        i.side !== "SELL" ||
        isTerminalIntentStatus(i.status)
      )
        continue;
      const remaining = big(i.quantity).minus(i.filledQuantity);
      accountPending = accountPending.plus(remaining);
      if (i.deploymentId === deployment.id)
        ownerPending = ownerPending.plus(remaining);
    }
    const available = Number.isFinite(position.sellable)
      ? position.sellable
      : 0;
    const attributed = big(position.quantity).minus(foreign.get(symbol) ?? 0);
    const limits = [
      { reason: "t_plus_1_locked", free: settled.minus(ownerPending) },
      {
        reason: "account_ownership_limit",
        free: attributed.minus(ownerPending),
      },
      {
        reason: accountPending.gt(0) ? "pending_sell" : "t_plus_1_locked",
        free: big(available).minus(accountPending),
      },
    ];
    const sellable = bigMin(...limits.map((limit) => limit.free));
    const sellLimitReason =
      ownerPending.gt(0) && sellable.eq(settled.minus(ownerPending))
        ? "pending_sell"
        : limits.find((limit) => limit.free.eq(sellable))!.reason;
    result.push({
      symbol,
      quantity,
      executionSellable: Math.max(0, sellable.toNumber()),
      pendingSell: ownerPending.toNumber(),
      sellLimitReason,
    });
  }
  return result;
}

/** Historical RPS backfills using today's Blocks do not establish past membership. */
export function decisionIndustries(date: string, db: Database.Database) {
  const groups = new Map<string, string[]>();
  const day = new RpsStore(db, "industry").day(date);
  const cutoff = Date.parse(date + "T23:59:59.999+08:00");
  if (day?.industry && day.createdAt <= cutoff) {
    for (const file of day.industry.snapshot.files) {
      if (file.mtimeMs > cutoff) continue;
      for (const raw of file.members) {
        const symbol = normalizePoolSymbol(raw);
        const memberships = groups.get(symbol) ?? [];
        memberships.push(file.name);
        groups.set(symbol, memberships);
      }
    }
  }
  return groups;
}
