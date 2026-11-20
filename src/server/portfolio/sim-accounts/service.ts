import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { chinaDate } from "~/lib/market/security-trading-status";
import {
  formatSimAtoms as formatAtoms,
  simAccountCreateSchema,
  simAccountRenameSchema,
  simAccountDeleteSchema,
  simAccountCashFlowSchema,
  simOrderPreviewSchema,
  simOrderConfirmSchema,
  simPlanBindingSchema,
  simAccountDetailQuerySchema,
  type SimAccountCreate,
  type SimAccountRename,
  type SimAccountDelete,
  type SimAccountCashFlow,
  type SimOrderPreview,
  type SimOrderConfirm,
  type SimAccountDetailQuery,
  type SimAccountDetail,
  type SimOrderPreviewResult,
  type SimPlanBinding,
  type SimPlanBindingInput,
} from "~/lib/portfolio/sim-accounts";
import { tradePlanSchema } from "~/server/db/strategy-repository";
import {
  accountView,
  SimAccountRepository,
} from "~/server/db/sim-account-repository";
import {
  checkedAtoms,
  parseAtoms,
  moneyDigits,
  quantityDigits,
  replayPositions,
  positionView,
  orderTerms,
  normalizeSimSymbol,
  settlementDate,
  quote,
  type OrderTerms,
} from "./engine";

type Db = Database.Database;
type Account = ReturnType<SimAccountRepository["account"]>;

export function ensureDefaultSimAccount(db: Db): void {
  const repo = new SimAccountRepository(db);
  repo.write(() => {
    if (repo.initialized()) return;
    const now = Date.now();
    if (!repo.hasAccounts())
      repo.open(
        randomUUID(),
        "A股默认模拟账户",
        "cn-equity",
        100_000_000n,
        now,
      );
    repo.markInitialized(now);
  });
}
export function listSimAccounts(db: Db) {
  const repo = new SimAccountRepository(db);
  if (!repo.initialized()) ensureDefaultSimAccount(db);
  return repo.list();
}
export function createSimAccount(input: SimAccountCreate, db: Db) {
  const { name, market, initialCapital } = simAccountCreateSchema.parse(input);
  const capital = parseAtoms(initialCapital, moneyDigits(market));
  const repo = new SimAccountRepository(db);
  return repo.write(() => {
    const id = randomUUID(),
      now = Date.now();
    repo.open(id, name, market, capital, now);
    // Explicit creation can precede the first visit to the account list.
    repo.markInitialized(now);
    return accountView(repo.account(id));
  });
}
function requireActive(account: Account) {
  if (account.status !== "active") throw new Error("模拟账户已归档");
}

const planIdentity = tradePlanSchema
  .pick({ symbol: true, market: true })
  .strip();
function compatiblePlan(
  repo: SimAccountRepository,
  planId: string,
  account: Account,
) {
  const row = repo.tradePlanContext(planId);
  if (!row) throw new Error("交易计划不存在");
  const plan = planIdentity.parse(JSON.parse(row.payload));
  if ((plan.market ?? row.strategyMarket) !== account.market)
    throw new Error("交易计划市场与模拟账户不匹配");
  return normalizeSimSymbol(plan.symbol, account.market);
}

const storedBinding = simPlanBindingSchema.extend({
  updatedAt: z.number().int(),
});
const bindingId = (planId: string) => "sim-plan-binding:" + planId;

export function simPlanBindingGet(
  planId: string,
  db: Db,
): SimPlanBinding | null {
  const payload = new SimAccountRepository(db).planBindingPayload(
    bindingId(planId),
  );
  return payload ? storedBinding.parse(JSON.parse(payload)) : null;
}

export function simPlanBindingSave(
  input: SimPlanBindingInput,
  db: Db,
): SimPlanBinding {
  const binding = simPlanBindingSchema.parse(input);
  const repo = new SimAccountRepository(db);
  return repo.write(() => {
    const account = repo.account(binding.accountId);
    requireActive(account);
    compatiblePlan(repo, binding.planId, account);
    const saved = { ...binding, updatedAt: Date.now() };
    repo.savePlanBinding(
      bindingId(binding.planId),
      JSON.stringify(saved),
      saved.updatedAt,
    );
    return saved;
  });
}
export function renameSimAccount(input: SimAccountRename, db: Db) {
  const { accountId, name } = simAccountRenameSchema.parse(input);
  const repo = new SimAccountRepository(db);
  return repo.write(() => {
    const account = repo.account(accountId);
    requireActive(account);
    if (account.name !== name) {
      repo.rename(accountId, name);
      repo.advance(accountId, Date.now());
    }
    return accountView(repo.account(accountId));
  });
}
export function postSimCashFlow(input: SimAccountCashFlow, db: Db) {
  const { accountId, requestId, kind, amount, note } =
    simAccountCashFlowSchema.parse(input);
  const repo = new SimAccountRepository(db);
  return repo.write(() => {
    const account = repo.account(accountId);
    const digits = moneyDigits(account.market);
    const delta =
      parseAtoms(amount, digits) * (kind === "withdrawal" ? -1n : 1n);
    const key = "cash:" + requestId;
    const existing = repo.flowByRequest(account, key);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.delta !== formatAtoms(delta, digits) ||
        existing.note !== note
      )
        throw new Error("资金流水幂等键冲突");
      return existing;
    }
    requireActive(account);
    if (checkedAtoms(account.cash_atoms + delta) < 0n)
      throw new Error("账户可用资金不足");
    const now = Date.now();
    repo.insertFlow(
      accountId,
      account.revision + 1n,
      key,
      kind,
      delta,
      null,
      now,
      note,
    );
    repo.advance(accountId, now);
    return repo.flowByRequest(account, key)!;
  });
}
export function deleteSimAccount(input: SimAccountDelete, db: Db): void {
  const { accountId } = simAccountDeleteSchema.parse(input);
  const repo = new SimAccountRepository(db);
  repo.write(() => {
    repo.account(accountId);
    repo.deletePlanBindingsForAccount(accountId);
    repo.markInitialized(Date.now());
    repo.remove(accountId);
  });
}
export function getSimAccountDetail(
  input: SimAccountDetailQuery,
  db: Db,
): SimAccountDetail {
  const { accountId, currentTradeDate, limit, cashFlowCursor, tradeCursor } =
    simAccountDetailQuerySchema.parse(input);
  const repo = new SimAccountRepository(db);
  return repo.read(() => {
    const row = repo.account(accountId),
      account = accountView(row);
    const today =
      row.market === "crypto"
        ? new Date().toISOString().slice(0, 10)
        : chinaDate(Date.now());
    const latest = repo.latestDate(accountId);
    const day = currentTradeDate ?? (latest && latest > today ? latest : today);
    const holdings = replayPositions(repo.fills(accountId), row.market, day);
    const cashFlows = repo.flows(row, cashFlowCursor, limit + 1),
      trades = repo.trades(row, tradeCursor, limit + 1);
    return {
      account,
      cash: account.cash,
      currentTradeDate: day,
      positions: Array.from(holdings, ([symbol, p]) =>
        positionView(symbol, p, row.market),
      ),
      cashFlows: cashFlows.slice(0, limit),
      trades: trades.slice(0, limit),
      nextCashFlowCursor:
        cashFlows.length > limit ? cashFlows[limit - 1]!.id : null,
      nextTradeCursor: trades.length > limit ? trades[limit - 1]!.fillId : null,
    };
  });
}

function evaluate(
  repo: SimAccountRepository,
  account: Account,
  terms: OrderTerms,
) {
  requireActive(account);
  if (settlementDate(account.market, terms.tradeDate) !== terms.tradeDate)
    throw new Error("A股周末休市，不能在该日期成交");
  if (terms.executionMode !== "manual") {
    if (!terms.planId) throw new Error("计划成交必须指定 planId");
    if (compatiblePlan(repo, terms.planId, account) !== terms.symbol)
      throw new Error("交易计划标的与委托不匹配");
  }
  const latest = repo.latestDate(account.id);
  if (latest && terms.tradeDate < latest)
    throw new Error("交易日期早于账户已成交日期");
  const held = replayPositions(
    repo.fills(account.id, terms.symbol),
    account.market,
    terms.tradeDate,
  ).get(terms.symbol);
  const sellable = held?.sellable ?? 0n;
  return {
    sellable,
    result: quote(terms, account.market, account.cash_atoms, sellable),
  };
}

export function previewSimOrder(
  input: SimOrderPreview,
  db: Db,
): SimOrderPreviewResult {
  const order = simOrderPreviewSchema.parse(input);
  const repo = new SimAccountRepository(db);
  return repo.read(() => {
    const account = repo.account(order.accountId);
    const terms = orderTerms(order, account.market);
    const { sellable, result } = evaluate(repo, account, terms);
    const money = (n: bigint) => formatAtoms(n, moneyDigits(account.market));
    const qty = (n: bigint) => formatAtoms(n, quantityDigits(account.market));
    return {
      ...terms,
      accountId: account.id,
      market: account.market,
      currency: account.currency,
      quantity: qty(terms.quantity),
      price: money(terms.price),
      gross: money(result.gross),
      commission: money(result.commission),
      tax: money(result.tax),
      slippage: money(result.slippage),
      netCashDelta: money(result.delta),
      cashBefore: money(account.cash_atoms),
      cashAfter: money(result.cashAfter),
      sellableQuantityBefore: qty(sellable),
    };
  });
}
export function confirmSimOrder(input: SimOrderConfirm, db: Db) {
  const order = simOrderConfirmSchema.parse(input);
  const repo = new SimAccountRepository(db);
  return repo.write(() => {
    const account = repo.account(order.accountId);
    const terms = orderTerms(order, account.market);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          ...terms,
          quantity: terms.quantity.toString(),
          price: terms.price.toString(),
        }),
      )
      .digest("hex");
    const existing = repo.orderByRequest(account.id, order.clientRequestId);
    if (existing) {
      if (existing.input_hash !== hash) throw new Error("委托幂等键冲突");
      return repo.receipt(account, existing.id);
    }
    const { result } = evaluate(repo, account, terms);
    return repo.settle(
      account,
      order.clientRequestId,
      hash,
      terms,
      result,
      Date.now(),
    );
  });
}
