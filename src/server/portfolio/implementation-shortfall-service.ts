import type Database from "better-sqlite3";
import { and, between, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { SimAccountRepository } from "../db/sim-account-repository";
import { big } from "trading-strategy-core/money";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import {
  AccountWorkspaceRepository,
  openAccountWorkspaceRead,
} from "../db/account-workspace-repository";
import { listFillLinksByAccount } from "../db/execution-fill-link-repository";
import { rebalanceOrderSchema } from "../db/rebalance-plan-repository";
import type { AccountTrade } from "~/lib/portfolio/account-workspace";
import { z } from "zod";
import { classifySecurityCode } from "trading-strategy-core/security";
import {
  calculateImplementationShortfall,
  implementationShortfallInputSchema,
  shortfallFrozenPlanSchema,
  type ShortfallActualFill,
  type ShortfallMissing,
} from "~/lib/portfolio/implementation-shortfall";
import { loadAccountBook, type AccountBook } from "./account-workspace-service";
import { paperDailyBars } from "./account-workspace/daily-bars";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import {
  loadReadOnlyAccountBook,
  readAccountSourceBars,
} from "./portfolio-risk-service";

const accountQuerySchema = z
  .object({
    account: z.string().trim().min(1).max(200),
    scope: z.enum(["real", "paper", "local_sim", "ths_mock"]).default("real"),
    from: z.string().date(),
    to: z.string().date(),
    /** All instructions with effects in this valuation window. IDs can be the
     * verified source plan/alert ID, or use explicit fillAssignments. */
    frozenPlan: shortfallFrozenPlanSchema.optional(),
    fillAssignments: z
      .record(z.string().min(1), z.string().min(1).nullable())
      .optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.from > input.to)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "结束日期早于开始日期",
      });
    if (input.frozenPlan) {
      const parsed = implementationShortfallInputSchema.safeParse({
        ...input.frozenPlan,
        terminalDate: input.to,
        actual: [],
      });
      if (!parsed.success)
        for (const issue of parsed.error.issues)
          ctx.addIssue({ ...issue, path: ["frozenPlan", ...issue.path] });
    } else if (input.fillAssignments) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fillAssignments"],
        message: "成交归属需要对应冻结计划",
      });
    }
  });

export const implementationShortfallQuerySchema = z.union([
  z.object({ ledgers: implementationShortfallInputSchema }).strict(),
  accountQuerySchema,
]);
export type ImplementationShortfallQuery = z.input<
  typeof implementationShortfallQuerySchema
>;

// Read projections on the supplied AccountBook connection. The writers own the
// complete table contracts and state transitions.
const intentTable = sqliteTable("execution_order_intents", {
  id: text().primaryKey(),
  run_id: text().notNull(),
  symbol: text().notNull(),
  side: text({ enum: ["BUY", "SELL"] }).notNull(),
  decision_date: text().notNull(),
  execute_date: text().notNull(),
  quantity: real().notNull(),
  reference_price: real().notNull(),
  created_at: integer().notNull(),
  venue_order_id: text(),
  filled_quantity: real(),
  status: text().notNull(),
  deployment_id: text().notNull(),
  venue_kind: text().notNull(),
  venue_binding_json: text().notNull(),
});
const auditTable = sqliteTable("execution_audit_events", {
  id: integer().primaryKey(),
  created_at: integer().notNull(),
  details_json: text().notNull(),
});
const runTable = sqliteTable("pipeline_runs", {
  id: text().primaryKey(),
  started_at: integer().notNull(),
  decision_date: text().notNull(),
  execute_date: text().notNull(),
  risk_verdict_json: text(),
});
const theoreticalOrder = z.object({
  symbol: symbolSchema,
  side: z.enum(["BUY", "SELL"]),
  theoreticalQuantity: z.number().int().safe().positive(),
  referencePrice: z.number().finite().positive(),
});
const ticketTable = sqliteTable("rebalance_plans", {
  id: text().primaryKey(),
  orders_json: text().notNull(),
  created_at: integer().notNull(),
  execute_date: text().notNull(),
});
type Query = z.output<typeof accountQuerySchema>;
type Frozen = z.output<typeof shortfallFrozenPlanSchema>;
type SimTrade = AccountTrade & {
  slippageCharge?: number;
  orderId?: string;
  fillId?: string;
  venueFillKey?: string;
  instructionId?: string;
};

/** Common holdings and cash before this window's trades. Only exact, dated
 * raw closes can value carry-in holdings. A flat opening needs no price. */
function simulationCashBasis(
  db: Database.Database,
  book: AccountBook,
  ledger: AccountBook["facts"]["localSim"][number],
  { account, from, to }: Query,
) {
  const start = Date.parse(from + "T00:00:00+08:00");
  const end = Date.parse(to + "T23:59:59.999+08:00");
  if (ledger.account.createdAt > end) return {};
  const repo = new SimAccountRepository(db);
  const flows = repo
    .flows(repo.account(account), undefined, -1)
    .filter((flow) => flow.kind !== "settlement" && flow.occurredAt <= end);
  if (!flows.some((f) => f.kind === "opening")) return {};
  let openingCash = big(0);
  let commonCash = big(0);
  for (const flow of flows) {
    const amount = big(flow.delta);
    commonCash = commonCash.plus(amount);
    if (flow.kind === "opening" || flow.occurredAt < start)
      openingCash = openingCash.plus(amount);
  }
  const holdings = new Map<string, number>();
  for (const f of ledger.trades) {
    if (f.tradeDate >= from) continue;
    if (f.netCashDelta === null) return {};
    openingCash = openingCash.plus(f.netCashDelta);
    commonCash = commonCash.plus(f.netCashDelta);
    holdings.set(
      f.symbol,
      (holdings.get(f.symbol) ?? 0) +
        (f.side === "buy" ? 1 : -1) * Number(f.quantity),
    );
  }
  const previous = book.calendar
    .filter((d) => d < from)
    .sort()
    .at(-1);
  for (const [symbol, quantity] of holdings) {
    if (!quantity) continue;
    const { coverageEnd, events } = book.context.evidence(symbol);
    if (
      !previous ||
      (classifySecurityCode(symbol.slice(2)).instrument === "stock" &&
        (!coverageEnd || coverageEnd < to)) ||
      events.some(
        (e) =>
          e.date > previous && e.date <= to && [1, 11, 12].includes(e.category),
      )
    )
      return {};
    const bars = book.bars[symbol] ?? [];
    const close = (day: string) => {
      const matches = bars.filter((b) => b.date === day);
      return matches.length === 1 &&
        Number.isFinite(matches[0]!.close) &&
        matches[0]!.close > 0
        ? matches[0]!.close
        : null;
    };
    const before = close(previous),
      after = close(to);
    if (before === null || after === null) return {};
    openingCash = openingCash.plus(big(before).times(quantity));
    commonCash = commonCash.plus(big(after).times(quantity));
  }
  return {
    openingNav: openingCash.toNumber(),
    commonTerminalValue: commonCash.toNumber(),
  };
}

function simulationEvidence(
  db: Database.Database,
  book: AccountBook,
  input: Query,
  scope: "local_sim" | "ths_mock",
  missing: ShortfallMissing[],
) {
  const { account, from, to } = input;
  const end = Date.parse(to + "T23:59:59.999+08:00");
  const plan: Frozen = {
    currency: "CNY",
    theoretical: [],
    executable: [],
    terminalPrices: {},
  };
  const trades: SimTrade[] = [];
  const fail = (field: string, reason: string, instructionId?: string) =>
    missing.push({ field, reason, instructionId });
  const reader = drizzle(db);
  const schemaVersion = Number(db.pragma("user_version", { simple: true }));
  const links =
    schemaVersion >= 26
      ? listFillLinksByAccount(
          { accountScope: scope, accountId: account },
          db,
        ).filter(
          (link) =>
            link.fillSource ===
            (scope === "local_sim" ? "sim_fills" : "ths_mock"),
        )
      : [];
  if (scope === "local_sim") {
    const ledger = book.facts.localSim.find(
      ({ account: a }) =>
        a.id === account && a.market === "cn-equity" && a.currency === "CNY",
    );
    if (!ledger) fail("account", "缺少人民币 A 股本地模拟账户");
    else {
      const basis = simulationCashBasis(db, book, ledger, input);
      Object.assign(plan, basis);
      const projected = new Map(
        book.trades
          .filter((t) => t.kind === "local-sim" && t.account === account)
          .map((t) => [t.id, t]),
      );
      for (const f of ledger.trades) {
        if (f.tradeDate < from || f.tradeDate > to) continue;
        const id = `local-sim:${account}:${f.fillId}`;
        const trade = projected.get(id);
        if (!trade) {
          fail("actualFill", "成交缺少统一账本投影");
          continue;
        }
        const fees = big(f.commission).plus(f.transfer).plus(f.tax);
        const bookedDelta = big(f.price)
          .times(f.quantity)
          .times(f.side === "buy" ? -1 : 1)
          .minus(fees)
          .minus(f.slippage);
        if (f.netCashDelta === null || !bookedDelta.eq(f.netCashDelta)) {
          missing.push({
            field: "settlement",
            reason: "逐笔价量和费用无法与记账现金核对",
            tradeId: id,
          });
        }
        const venueFillKey = JSON.stringify([
          scope + ":" + account,
          f.symbol,
          f.tradeDate,
          f.orderId,
          f.fillId,
        ]);
        trades.push({
          ...trade,
          venueFillKey,
          timePrecision:
            chinaClock(f.executedAt).date === f.tradeDate ? "instant" : "day",
          fees: fees.toNumber(),
          slippageCharge: Number(f.slippage),
          orderId: f.orderId,
          fillId: f.fillId,
        });
      }
    }
  } else {
    trades.push(
      ...book.trades
        .filter(
          (trade) =>
            trade.kind === "ths-mock" &&
            trade.market === "cn-equity" &&
            trade.account === account &&
            trade.date.slice(0, 10) >= from &&
            trade.date.slice(0, 10) <= to,
        )
        .map((trade) => ({ ...trade })),
    );
    if (!trades.length) fail("actualFills", "缺少本地已核实的同花顺逐笔成交");
  }

  // The frozen binding belongs to the intent, even after a deployment changes account.
  const i = intentTable;
  const intents =
    schemaVersion < 25
      ? []
      : reader
          .select({
            id: i.id,
            runId: i.run_id,
            symbol: i.symbol,
            side: sql<"buy" | "sell">`lower(${i.side})`,
            decision_date: i.decision_date,
            execute_date: i.execute_date,
            quantity: i.quantity,
            reference_price: i.reference_price,
            created_at: i.created_at,
            venue_order_id: i.venue_order_id,
            filled_quantity: i.filled_quantity,
            status: i.status,
            zeroLimit: sql<number>`EXISTS(SELECT 1 FROM execution_audit_events
              WHERE intent_id=${i.id} AND event_type='execution_risk_limit'
                AND json_extract(details_json,'$.quantity')=0
                AND json_extract(details_json,'$.reason') IN ('instrument_cap','industry_cap','total_exposure_cap'))`,
            arrival_at: auditTable.created_at,
            planned: sql<
              number | null
            >`json_extract(${auditTable.details_json},'$.plannedQuantity')`,
            executable: sql<
              number | null
            >`json_extract(${auditTable.details_json},'$.quantity')`,
            quoted_price: sql<
              number | null
            >`json_extract(${auditTable.details_json},'$.arrivalPrice')`,
          })
          .from(i)
          .leftJoin(
            auditTable,
            eq(
              auditTable.id,
              sql`(SELECT MAX(id) FROM execution_audit_events
    WHERE deployment_id=${i.deployment_id} AND intent_id=${i.id} AND event_type='execution_arrival')`,
            ),
          )
          .where(
            and(
              eq(i.venue_kind, scope),
              between(i.execute_date, from, to),
              eq(
                sql`json_extract(${i.venue_binding_json},${scope === "local_sim" ? "$.simAccountId" : "$.accountTag"})`,
                account,
              ),
            ),
          )
          .orderBy(i.created_at, i.id)
          .all();
  // Use the account frozen at decision time, including runs where every
  // proposed order was clipped to zero and no intent exists to join.
  const theoreticalByIntent = new Map<string, number>();
  let earliestDecision = from;
  if (scope === "local_sim" && schemaVersion >= 25) {
    const runs = reader
      .select()
      .from(runTable)
      .where(
        and(
          between(runTable.execute_date, from, to),
          eq(
            sql`json_extract(${runTable.risk_verdict_json}, '$.accountScope')`,
            scope,
          ),
          eq(
            sql`json_extract(${runTable.risk_verdict_json}, '$.accountId')`,
            account,
          ),
          sql`json_type(${runTable.risk_verdict_json}, '$.theoreticalOrders') IS NOT NULL`,
        ),
      )
      .all();
    const orderKey = (runId: string, symbol: string, side: string) =>
      JSON.stringify([runId, symbol, side.toLowerCase()]);
    const intentByOrder = new Map(
      intents.map((i) => [orderKey(i.runId, i.symbol, i.side), i]),
    );
    for (const run of runs) {
      if (run.started_at > end) continue;
      const evidence = z
        .object({
          theoreticalOrders: z.array(theoreticalOrder),
          skipped: z.array(z.object({ symbol: z.string(), side: z.string() })),
        })
        .safeParse(JSON.parse(run.risk_verdict_json!));
      if (!evidence.success) {
        fail("theoreticalQuantity", "风控前理论数量证据无效", run.id);
        continue;
      }
      if (run.decision_date < earliestDecision)
        earliestDecision = run.decision_date;
      for (const order of evidence.data.theoreticalOrders) {
        const key = orderKey(run.id, order.symbol, order.side);
        const intent = intentByOrder.get(key);
        if (intent) {
          theoreticalByIntent.set(intent.id, order.theoreticalQuantity);
          continue;
        }
        if (
          !evidence.data.skipped.some(
            (s) => s.symbol === order.symbol && s.side === order.side,
          )
        ) {
          fail("executionStatus", "理论指令缺少对应委托或风控拒单记录", key);
          continue;
        }
        plan.theoretical.push({
          id: key,
          symbol: order.symbol,
          side: order.side === "BUY" ? "buy" : "sell",
          signalAt: run.started_at,
          quantity: order.theoreticalQuantity,
          decisionPrice: order.referencePrice,
          fees: 0,
        });
        plan.executable.push({ instructionId: key, quantity: 0, fees: 0 });
      }
    }
  }
  const byIntent = new Map(intents.map((intent) => [intent.id, intent]));
  const linksByFill = new Map(links.map((link) => [link.fillId, link]));
  const bookedQuantity = new Map<string, number>();
  const arrivals = new Map<string, Set<number | null>>();
  for (const trade of trades) {
    const identities = [
      trade.venueFillKey,
      trade.id,
      trade.fillId,
      trade.fillId && `${account}:${trade.fillId}`,
    ];
    const exact = new Set(
      identities.flatMap((id) => {
        const link = id ? linksByFill.get(id) : undefined;
        return link ? [link] : [];
      }),
    );
    const link = exact.size === 1 ? [...exact][0] : undefined;
    if (!link) {
      missing.push({
        field: "fillLink",
        reason: "成交缺少唯一的账户级执行关联",
        tradeId: trade.id,
      });
      // The unique local order can recover provenance, never an arrival price.
      if (exact.size || !trade.orderId) continue;
    }
    const venueOrder = link?.venueOrderId ?? trade.orderId;
    const associated = link?.intentId
      ? [byIntent.get(link.intentId)]
      : intents.filter(
          (i) => i.venue_order_id !== null && i.venue_order_id === venueOrder,
        );
    const intent = associated.length === 1 ? associated[0] : undefined;
    if (
      intent &&
      intent.symbol === trade.symbol &&
      intent.side === trade.side &&
      intent.execute_date === trade.date.slice(0, 10) &&
      (!link?.venueOrderId ||
        !trade.orderId ||
        link.venueOrderId === trade.orderId) &&
      (!intent.venue_order_id ||
        !venueOrder ||
        intent.venue_order_id === venueOrder)
    ) {
      trade.instructionId = intent.id;
    } else if (
      link &&
      !link.intentId &&
      !associated.length &&
      link.rebalancePlanId
    ) {
      // A ticket can target a different source ledger. Only the explicit scoped
      // fill link authorizes using that ticket for this simulation account.
      const ticket = reader
        .select()
        .from(ticketTable)
        .where(
          and(
            eq(ticketTable.id, link.rebalancePlanId),
            eq(ticketTable.execute_date, trade.date.slice(0, 10)),
          ),
        )
        .get();
      const parsed =
        ticket &&
        z.array(rebalanceOrderSchema).safeParse(JSON.parse(ticket.orders_json));
      const orders = parsed?.success
        ? parsed.data.filter(
            (o) => o.symbol === trade.symbol && o.side === trade.side,
          )
        : [];
      if (ticket && orders.length === 1 && ticket.created_at <= end) {
        const order = orders[0]!;
        const id = JSON.stringify([
          link.rebalancePlanId,
          order.symbol,
          order.side,
        ]);
        trade.instructionId = id;
        if (!plan.theoretical.some((row) => row.id === id)) {
          const estimates = order.riskChecks.filter(
            (c) => c.code === "ticket.estimate.v1" && c.status === "passed",
          );
          const evidence = estimates.length === 1 && estimates[0]?.detail;
          let estimate: { close: number; estimatedFeesCny: number } | undefined;
          if (evidence) {
            try {
              estimate = z
                .object({
                  close: z.number().positive(),
                  estimatedFeesCny: z.number().nonnegative(),
                })
                .parse(JSON.parse(evidence));
            } catch {
              /* Malformed legacy estimates remain missing. */
            }
          }
          plan.theoretical.push({
            id,
            signalAt: ticket.created_at,
            symbol: order.symbol,
            side: order.side,
            decisionPrice: estimate?.close,
            quantity: order.quantity,
            fees: estimate?.estimatedFeesCny,
          });
        }
        // The ticket alone does not prove an executable quantity or arrival time.
      }
    }
    if (!trade.instructionId)
      fail("instructionId", "成交关联与当前账户的指令或调仓单不一致");
    else {
      bookedQuantity.set(
        trade.instructionId,
        (bookedQuantity.get(trade.instructionId) ?? 0) + trade.quantity,
      );
      const prices = arrivals.get(trade.instructionId) ?? new Set();
      prices.add(link?.arrivalPrice ?? null);
      arrivals.set(trade.instructionId, prices);
    }
  }
  for (const i of intents) {
    if (
      !symbolSchema.safeParse(i.symbol).success ||
      !Number.isSafeInteger(i.quantity) ||
      i.created_at > end
    ) {
      fail("instruction", "指令股数、证券或时间无法核验", i.id);
      continue;
    }
    // Submission can overwrite intent.quantity. A missing original size on
    // an arrival record cannot be reconstructed from the executed size.
    const planned =
      theoreticalByIntent.get(i.id) ??
      i.planned ??
      (["planned", "queued"].includes(i.status) ? i.quantity : null);
    if (planned === null || !Number.isSafeInteger(planned) || planned <= 0) {
      fail("theoreticalQuantity", "缺少有效计划股数", i.id);
      continue;
    }
    // Perold's gross paper portfolios incur no transaction costs by definition.
    plan.theoretical.push({
      id: i.id,
      symbol: i.symbol,
      side: i.side,
      signalAt: i.created_at,
      decisionPrice: i.reference_price,
      quantity: planned,
      fees: 0,
    });
    const riskRejected =
      scope === "local_sim" && i.status === "rejected" && i.zeroLimit === 1;
    if (riskRejected) {
      plan.executable.push({ instructionId: i.id, quantity: 0, fees: 0 });
    } else if (
      i.executable !== null &&
      Number.isSafeInteger(i.executable) &&
      i.executable > 0 &&
      i.executable <= planned
    ) {
      const prices = arrivals.get(i.id);
      // A terminal zero-fill order has no link by design. Its submission
      // audit still freezes the arrival benchmark for missed shares.
      const quote =
        typeof i.quoted_price === "number" &&
        Number.isFinite(i.quoted_price) &&
        i.quoted_price > 0
          ? i.quoted_price
          : null;
      const arrivalPrice =
        prices?.size === 1
          ? [...prices][0]
          : !prices && i.filled_quantity === 0
            ? quote
            : null;
      if (arrivalPrice != null && quote !== null && arrivalPrice !== quote)
        fail("arrivalPrice", "成交关联与提交时记录的到达价不一致", i.id);
      plan.executable.push({
        instructionId: i.id,
        quantity: i.executable,
        arrivalPrice,
        arrivalAt:
          i.arrival_at !== null &&
          i.arrival_at >= i.created_at &&
          i.arrival_at <= end
            ? i.arrival_at
            : null,
        fees: 0,
      });
    }
    const qty = bookedQuantity.get(i.id) ?? 0;
    if (
      !["filled", "rejected", "cancelled"].includes(i.status) ||
      (i.filled_quantity === null && !riskRejected) ||
      qty !== (i.filled_quantity ?? 0)
    )
      fail("executionStatus", "缺少已终结且与逐笔成交数量一致的执行回执", i.id);
  }
  if (!plan.theoretical.length) fail("frozenPlan", "缺少可追溯的冻结执行指令");
  return {
    trades,
    plan,
    earliestDecision: intents.reduce(
      (date, i) => (i.decision_date < date ? i.decision_date : date),
      earliestDecision,
    ),
  };
}

async function accountShortfall(
  book: AccountBook,
  input: z.output<typeof accountQuerySchema>,
  at: number,
  db?: Database.Database,
) {
  const { account, scope, from, to } = input;
  const missing: ShortfallMissing[] = [];
  const simulated = scope === "local_sim" || scope === "ths_mock";
  const evidence =
    simulated && db
      ? new SimAccountRepository(db).read(() => {
          new AccountWorkspaceRepository(db).assertVersion(book.facts.version);
          return simulationEvidence(db, book, input, scope, missing);
        })
      : undefined;
  if (simulated && !db)
    missing.push({
      field: "database",
      reason: "缺少与账户快照同源的执行数据库",
    });
  const frozenPlan = input.frozenPlan ?? evidence?.plan;
  const paper =
    scope === "paper"
      ? book.facts.paper.find((entry) => entry.account.id === account)
      : undefined;
  const delivery = new Map(
    book.facts.fills
      .filter((fill) => fill.account === account)
      .map((fill) => [`delivery:${fill.id}`, fill]),
  );
  const local = new Map(
    book.facts.local.map((fill) => [`local:${fill.id}`, fill]),
  );
  const paperFills = new Map(
    paper?.state?.result.fills.map((fill, index) => [
      `paper:${account}:${index}`,
      fill,
    ]),
  );
  const eligiblePaper =
    paper?.account.market === "cn-equity" && paper.account.currency === "CNY";
  if (scope === "paper" && (!eligiblePaper || !paper.state))
    missing.push({
      field: "account",
      reason: "缺少已记账的人民币 A 股纸面账户",
    });
  if (
    scope === "real" &&
    !book.facts.batches.some((batch) => batch.account === account) &&
    !(account === "手工账本" && local.size)
  )
    missing.push({ field: "account", reason: "缺少选定的人民币真实账本" });
  if (!frozenPlan)
    missing.push({
      field: "frozenPlan",
      reason:
        "成交的策略来源关联不包含完整冻结指令、理论费用和次一合法到达基准",
    });
  const candidates: SimTrade[] =
    evidence?.trades ??
    book.trades.filter(
      (trade) =>
        trade.kind === scope &&
        trade.account === account &&
        trade.market === "cn-equity" &&
        (scope !== "paper" || eligiblePaper) &&
        trade.date.slice(0, 10) >= from &&
        trade.date.slice(0, 10) <= to,
    );
  const planById = new Map(
    frozenPlan?.theoretical.map((plan) => [plan.id, plan]),
  );
  const plannedSides = new Set(
    frozenPlan?.theoretical.map((plan) => `${plan.symbol}:${plan.side}`),
  );
  const unusedAssignments = new Set(Object.keys(input.fillAssignments ?? {}));
  const actual: ShortfallActualFill[] = [];
  const sources = [];
  for (const trade of candidates) {
    const statement = delivery.get(trade.id);
    if (statement?.instrument === "reverseRepo") continue;
    sources.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      side: trade.side,
      date: trade.date.slice(0, 10),
      strategyId: trade.strategyId,
      strategyVersion: trade.strategyVersion,
      planId: trade.planId,
      ...(simulated && { instructionId: trade.instructionId ?? null }),
      alertKey: trade.alertKey,
    });
    if (
      statement &&
      statement.instrument !== "stock" &&
      statement.instrument !== "fund"
    ) {
      missing.push({
        field: "quantityUnit",
        reason: "交割单证券的数量与期末估值单位须先核定",
        tradeId: trade.id,
        symbol: trade.symbol,
      });
      continue;
    }
    if (!Number.isSafeInteger(trade.quantity) || trade.quantity <= 0) {
      missing.push({
        field: "actualQuantity",
        reason: "实际成交缺少有效的整数股数",
        tradeId: trade.id,
        symbol: trade.symbol,
      });
      continue;
    }
    const validPlan = (id: string) => {
      const plan = planById.get(id);
      return plan?.symbol === trade.symbol && plan.side === trade.side;
    };
    const possible = [
      trade.instructionId ?? null,
      trade.planId,
      trade.alertKey,
    ].filter((id): id is string => {
      return id !== null && validPlan(id);
    });
    const verified = [...new Set(possible)];
    const override = input.fillAssignments;
    const instructionId =
      override && Object.hasOwn(override, trade.id)
        ? override[trade.id]
        : verified.length === 1
          ? verified[0]
          : !simulated &&
              frozenPlan &&
              !plannedSides.has(`${trade.symbol}:${trade.side}`)
            ? null
            : undefined;
    unusedAssignments.delete(trade.id);
    if (instructionId != null && !validPlan(instructionId)) {
      missing.push({
        field: "fillAssignments",
        reason: "指定指令与实际成交的证券或方向不符，或指令不存在",
        tradeId: trade.id,
        instructionId,
        symbol: trade.symbol,
      });
      continue;
    }
    const simulation = paperFills.get(trade.id);
    const filledAt =
      trade.timePrecision === "instant" || (simulation?.date.length ?? 0) > 10
        ? trade.time
        : undefined;
    actual.push({
      id: trade.id,
      instructionId,
      symbol: trade.symbol,
      side: trade.side,
      date: trade.date.slice(0, 10),
      filledAt: Number.isFinite(filledAt) ? filledAt : undefined,
      fillPrice:
        Number.isFinite(trade.price) && trade.price > 0 ? trade.price : null,
      quantity: trade.quantity,
      slippageCharge: trade.slippageCharge,
      fees:
        statement?.fees.total ??
        local.get(trade.id)?.fees.total ??
        simulation?.fee ??
        (simulated ? trade.fees : null) ??
        null,
    });
  }
  for (const tradeId of unusedAssignments)
    missing.push({
      field: "fillAssignments",
      reason: "指定成交不在本账户与区间的可归因成交内",
      tradeId,
    });
  const paperBars = scope === "paper" ? paperDailyBars(book, account) : {};
  const terminalPrices = { ...frozenPlan?.terminalPrices };
  const symbols = new Set([
    ...actual.map((fill) => fill.symbol),
    ...(frozenPlan?.theoretical.map((row) => row.symbol) ?? []),
  ]);
  const now = chinaClock(at);
  const completed = to < now.date || (to === now.date && now.time >= "15:05");
  const earliestSignalDate = (frozenPlan?.theoretical ?? []).reduce(
    (earliest, row) => {
      const signalDay = chinaClock(row.signalAt).date;
      return signalDay < earliest ? signalDay : earliest;
    },
    evidence?.earliestDecision ?? from,
  );
  // Include first-day and pre-window-signal corporate actions so a split on `from`
  // cannot leave decision, fill and terminal prices on mismatched share bases.
  const inActionWindow = (date: string) =>
    date >= earliestSignalDate && date <= to;
  const paperActionSymbols = new Set(
    paper?.state?.request.instruments
      .filter((instrument) =>
        instrument.actions?.some((action) => inActionWindow(action.date)),
      )
      .map((instrument) => instrument.symbol),
  );
  const actionGaps = new Map<string, ShortfallMissing>();
  for (const symbol of symbols) {
    // Frozen paper actions identify events. Their absence cannot establish
    // coverage, so both account scopes require a dated GBBQ source for stocks.
    const { coverageEnd, events } = book.context.evidence(symbol);
    if (
      classifySecurityCode(symbol.slice(2)).instrument === "stock" &&
      (!coverageEnd || coverageEnd < to)
    ) {
      actionGaps.set(symbol, {
        field: "corporateActionCoverage",
        reason: `GBBQ 公司行动覆盖截止日 ${coverageEnd ?? "未知"}，无法核验至估值结束日 ${to}`,
        symbol,
      });
    } else if (
      paperActionSymbols.has(symbol) ||
      events.some(
        (event) =>
          inActionWindow(event.date) && [1, 11, 12].includes(event.category),
      )
    ) {
      actionGaps.set(symbol, {
        field: "quantityUnit",
        reason:
          "区间有除权或股数变化，账户成交与期末估值须先换算为同一股份口径",
        symbol,
      });
    }
    // Local raw close at the exact valuation date. No previous close or fill-price fallback.
    if (Object.hasOwn(terminalPrices, symbol) || !completed) continue;
    const localMarks =
      book.bars[symbol]?.filter((bar) => bar.date === to) ?? [];
    const frozenMarks =
      paperBars[symbol]?.filter((bar) => bar.date === to) ?? [];
    const marks = localMarks.length
      ? localMarks
      : frozenMarks.length
        ? frozenMarks
        : !Object.hasOwn(book.bars, symbol) && book.config
          ? (await readAccountSourceBars(book.config.tdxRoot, symbol)).filter(
              (bar) => bar.date === to,
            )
          : [];
    if (
      marks.length === 1 &&
      Number.isFinite(marks[0]!.close) &&
      marks[0]!.close > 0
    )
      terminalPrices[symbol] = marks[0]!.close;
  }
  const report = calculateImplementationShortfall(
    {
      openingNav: frozenPlan?.openingNav,
      commonTerminalValue: frozenPlan?.commonTerminalValue,
      theoretical: frozenPlan?.theoretical ?? [],
      executable: frozenPlan?.executable ?? [],
      terminalDate: to,
      terminalPrices,
      actual,
    },
    [...missing, ...actionGaps.values()],
  );
  return {
    ...report,
    rows: report.rows.map((row) => {
      const gap = actionGaps.get(row.symbol);
      return gap
        ? {
            ...row,
            matchedQuantity: null,
            fills: row.fills.map((fill) => ({
              ...fill,
              matchedQuantity: null,
            })),
            reconciliation: null,
            missing: [...row.missing, gap],
          }
        : row;
    }),
    source: {
      kind: "account" as const,
      account,
      scope,
      from,
      to,
      trades: sources,
      ...(simulated &&
        !input.frozenPlan && {
          pipelineCostBenchmark: "gross-before-costs" as const,
        }),
    },
  };
}

export async function readImplementationShortfall(
  value: ImplementationShortfallQuery,
  readBook?: (at: number) => Promise<AccountBook>,
  at = Date.now(),
  db?: Database.Database,
) {
  const input = implementationShortfallQuerySchema.parse(value);
  if ("ledgers" in input)
    return {
      ...calculateImplementationShortfall(input.ledgers),
      source: { kind: "explicit" as const },
    };
  if (readBook || (input.scope !== "local_sim" && input.scope !== "ths_mock")) {
    return accountShortfall(
      await (readBook ?? loadReadOnlyAccountBook)(at),
      input,
      at,
      db,
    );
  }
  const reader = db
    ? { repo: new AccountWorkspaceRepository(db), close: () => {} }
    : openAccountWorkspaceRead();
  try {
    const book = await loadAccountBook(
      reader.repo ?? undefined,
      undefined,
      at,
      { localOnly: true },
    );
    return await accountShortfall(book, input, at, reader.repo?.db);
  } finally {
    reader.close();
  }
}
