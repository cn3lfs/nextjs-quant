import type Database from "better-sqlite3";
import { formatSimAtoms as formatAtoms } from "~/lib/portfolio/sim-accounts";
import type {
  SimAccountSummary,
  SimCashFlowRow,
  SimTradeRow,
} from "~/lib/portfolio/sim-accounts";
import {
  moneyDigits,
  quantityDigits,
  type Market,
  type OrderTerms,
  type ReplayFill,
  type quote,
} from "../portfolio/sim-accounts/engine";

interface AccountRow {
  id: string;
  name: string;
  market: Market;
  currency: SimAccountSummary["currency"];
  status: SimAccountSummary["status"];
  initial_capital_atoms: bigint;
  cash_atoms: bigint;
  revision: bigint;
  created_at: bigint;
  updated_at: bigint;
  archived_at: bigint | null;
}
interface FlowRow {
  account_id: string;
  id: string;
  request_id: string;
  kind: SimCashFlowRow["kind"];
  delta_atoms: bigint;
  fill_id: string | null;
  occurred_at: bigint;
  note: string;
}
interface TradeRow extends ReplayFill {
  account_id: string;
  id: string;
  order_id: string;
  transfer_atoms: bigint;
  price_atoms: bigint;
  executed_at: bigint;
  client_request_id: string;
  execution_mode: SimTradeRow["executionMode"];
  plan_id: string | null;
  delta_atoms: bigint;
}
// Revision order keeps intermediate sums inside the same checked balance range as writes.
const accounts = `SELECT a.*, (SELECT SUM(delta_atoms ORDER BY id) FROM sim_cash_flows
  WHERE account_id=a.id) AS cash_atoms FROM sim_accounts a`;
const trades = `SELECT f.*, o.client_request_id,o.execution_mode,o.plan_id,c.delta_atoms
  FROM sim_fills f JOIN sim_orders o ON o.account_id=f.account_id AND o.id=f.order_id
  JOIN sim_cash_flows c ON c.account_id=f.account_id AND c.fill_id=f.id`;
const marker = "sim-accounts:initialized";
function safeNumber(value: bigint) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error("账户元数据超出安全整数范围");
  return n;
}
export function accountView(row: AccountRow): SimAccountSummary {
  const digits = moneyDigits(row.market);
  return {
    id: row.id,
    name: row.name,
    market: row.market,
    currency: row.currency,
    status: row.status,
    initialCapital: formatAtoms(row.initial_capital_atoms, digits),
    cash: formatAtoms(row.cash_atoms, digits),
    revision: safeNumber(row.revision),
    createdAt: safeNumber(row.created_at),
    updatedAt: safeNumber(row.updated_at),
    archivedAt: row.archived_at === null ? null : safeNumber(row.archived_at),
  };
}
function flowView(row: FlowRow, market: Market): SimCashFlowRow {
  const manual = row.kind === "deposit" || row.kind === "withdrawal";
  return {
    accountId: row.account_id,
    id: row.id,
    requestId: manual ? row.request_id.slice("cash:".length) : row.request_id,
    kind: row.kind,
    delta: formatAtoms(row.delta_atoms, moneyDigits(market)),
    fillId: row.fill_id,
    occurredAt: safeNumber(row.occurred_at),
    note: row.note,
  };
}
function tradeView(row: TradeRow, account: AccountRow): SimTradeRow {
  const money = (n: bigint) => formatAtoms(n, moneyDigits(account.market));
  return {
    accountId: account.id,
    market: account.market,
    currency: account.currency,
    orderId: row.order_id,
    fillId: row.id,
    clientRequestId: row.client_request_id,
    executedAt: safeNumber(row.executed_at),
    symbol: row.symbol,
    side: row.side,
    executionMode: row.execution_mode,
    planId: row.plan_id,
    tradeDate: row.trade_date,
    quantity: formatAtoms(row.quantity_atoms, quantityDigits(account.market)),
    price: money(row.price_atoms),
    gross: money(row.gross_atoms),
    commission: money(row.commission_atoms),
    transfer: money(row.transfer_atoms),
    tax: money(row.tax_atoms),
    slippage: money(row.slippage_atoms),
    netCashDelta: money(row.delta_atoms),
  };
}
const sequence = (revision: bigint) => revision.toString().padStart(19, "0");

// The caller owns the transaction so validation and all related writes share a snapshot.
export class SimAccountRepository {
  constructor(private readonly db: Database.Database) {}
  read<T>(work: () => T): T {
    return this.db.transaction(work)();
  }
  write<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }
  initialized() {
    return !!this.db.prepare("SELECT 1 FROM records WHERE id=?").get(marker);
  }
  markInitialized(now: number) {
    this.db
      .prepare(
        "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,'sim_accounts_initialized','{}',?) ON CONFLICT(id) DO NOTHING",
      )
      .run(marker, now);
  }
  hasAccounts() {
    return !!this.db.prepare("SELECT 1 FROM sim_accounts LIMIT 1").get();
  }
  open(id: string, name: string, market: Market, capital: bigint, now: number) {
    this.db
      .prepare(
        `INSERT INTO sim_accounts(id,name,market,currency,initial_capital_atoms,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        name,
        market,
        market === "crypto" ? "USDT" : "CNY",
        capital,
        now,
        now,
      );
    this.insertFlow(id, 0n, "opening", "opening", capital, null, now, "");
  }
  list() {
    return this.db
      .prepare<[], AccountRow>(accounts + " ORDER BY a.created_at,a.id")
      .safeIntegers()
      .all()
      .map(accountView);
  }
  account(id: string) {
    const row = this.db
      .prepare<[string], AccountRow>(accounts + " WHERE a.id=?")
      .safeIntegers()
      .get(id);
    if (!row) throw new Error("模拟账户不存在");
    return row;
  }
  advance(id: string, now: number) {
    this.db
      .prepare(
        "UPDATE sim_accounts SET revision=revision+1, updated_at=? WHERE id=?",
      )
      .run(now, id);
  }
  rename(id: string, name: string) {
    this.db.prepare("UPDATE sim_accounts SET name=? WHERE id=?").run(name, id);
  }
  remove(id: string) {
    this.db.prepare("DELETE FROM sim_cash_flows WHERE account_id=?").run(id);
    this.db.prepare("DELETE FROM sim_fills WHERE account_id=?").run(id);
    this.db.prepare("DELETE FROM sim_orders WHERE account_id=?").run(id);
    this.db.prepare("DELETE FROM sim_accounts WHERE id=?").run(id);
  }
  insertFlow(
    id: string,
    revision: bigint,
    request: string,
    kind: FlowRow["kind"],
    delta: bigint,
    fill: string | null,
    now: number,
    note: string,
  ) {
    this.db
      .prepare(
        `INSERT INTO sim_cash_flows(account_id,id,request_id,kind,delta_atoms,fill_id,occurred_at,note)
      VALUES(?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        "flow-" + sequence(revision),
        request,
        kind,
        delta,
        fill,
        now,
        note,
      );
  }
  flowByRequest(account: AccountRow, request: string) {
    const row = this.db
      .prepare<[string, string], FlowRow>(
        "SELECT * FROM sim_cash_flows WHERE account_id=? AND request_id=?",
      )
      .safeIntegers()
      .get(account.id, request);
    return row && flowView(row, account.market);
  }
  flows(account: AccountRow, cursor: string | undefined, limit: number) {
    const sql =
      "SELECT * FROM sim_cash_flows WHERE account_id=? " +
      (cursor ? "AND id < ? " : "") +
      "ORDER BY id DESC LIMIT ?";
    return this.db
      .prepare<(string | number)[], FlowRow>(sql)
      .safeIntegers()
      .all(account.id, ...(cursor ? [cursor] : []), limit)
      .map((row) => flowView(row, account.market));
  }
  trades(account: AccountRow, cursor: string | undefined, limit: number) {
    const sql =
      trades +
      " WHERE f.account_id=? " +
      (cursor ? "AND f.id < ? " : "") +
      "ORDER BY f.id DESC LIMIT ?";
    return this.db
      .prepare<(string | number)[], TradeRow>(sql)
      .safeIntegers()
      .all(account.id, ...(cursor ? [cursor] : []), limit)
      .map((row) => tradeView(row, account));
  }
  fills(id: string, symbol?: string) {
    const sql =
      "SELECT * FROM sim_fills WHERE account_id=? " +
      (symbol ? "AND symbol=? " : "") +
      "ORDER BY id";
    return this.db
      .prepare<string[], ReplayFill>(sql)
      .safeIntegers()
      .iterate(id, ...(symbol ? [symbol] : []));
  }
  latestDate(id: string) {
    return this.db
      .prepare<[string], { trade_date: string }>(
        "SELECT trade_date FROM sim_orders WHERE account_id=? ORDER BY trade_date DESC,id DESC LIMIT 1",
      )
      .get(id)?.trade_date;
  }
  orderByRequest(id: string, request: string) {
    return this.db
      .prepare<[string, string], { id: string; input_hash: string }>(
        "SELECT id,input_hash FROM sim_orders WHERE account_id=? AND client_request_id=?",
      )
      .get(id, request);
  }
  receipt(account: AccountRow, orderId: string) {
    const row = this.db
      .prepare<[string, string], TradeRow>(
        trades + " WHERE f.account_id=? AND f.order_id=?",
      )
      .safeIntegers()
      .get(account.id, orderId);
    if (!row) throw new Error("缺少已确认委托的成交或结算流水");
    return tradeView(row, account);
  }
  settle(
    account: AccountRow,
    request: string,
    hash: string,
    terms: OrderTerms,
    result: ReturnType<typeof quote>,
    now: number,
  ) {
    const revision = account.revision + 1n;
    const seq = sequence(revision),
      order = "order-" + seq,
      fill = "fill-" + seq;
    this.db
      .prepare(
        `INSERT INTO sim_orders(account_id,id,client_request_id,input_hash,symbol,side,execution_mode,plan_id,quantity_atoms,price_atoms,trade_date,confirmed_at,rules_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        account.id,
        order,
        request,
        hash,
        terms.symbol,
        terms.side,
        terms.executionMode,
        terms.planId,
        terms.quantity,
        terms.price,
        terms.tradeDate,
        now,
        JSON.stringify({
          version: "local-sim-1",
          market: account.market,
          moneyDigits: moneyDigits(account.market),
          quantityDigits: quantityDigits(account.market),
          costs: result.costs,
        }),
      );
    this.db
      .prepare(
        `INSERT INTO sim_fills(account_id,id,order_id,symbol,side,quantity_atoms,price_atoms,gross_atoms,commission_atoms,transfer_atoms,tax_atoms,slippage_atoms,trade_date,executed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        account.id,
        fill,
        order,
        terms.symbol,
        terms.side,
        terms.quantity,
        terms.price,
        result.gross,
        result.commission,
        result.transfer,
        result.tax,
        result.slippage,
        terms.tradeDate,
        now,
      );
    this.insertFlow(
      account.id,
      revision,
      order,
      "settlement",
      result.delta,
      fill,
      now,
      "",
    );
    this.advance(account.id, now);
    return this.receipt(account, order);
  }
  tradePlanContext(planId: string) {
    return this.db
      .prepare<[string], { payload: string; strategyMarket: string }>(
        `SELECT p.payload, s.market AS strategyMarket
        FROM trade_plans p JOIN strategies s
          ON s.id=p.strategy_id AND s.version=p.strategy_version
        WHERE p.id=?`,
      )
      .get(planId);
  }
  planBindingPayload(bindingId: string) {
    return this.db
      .prepare<[string], { payload: string }>(
        "SELECT payload FROM records WHERE kind='sim-plan-binding' AND id=?",
      )
      .get(bindingId)?.payload;
  }
  savePlanBinding(bindingId: string, payload: string, updatedAt: number) {
    this.db
      .prepare(
        `INSERT INTO records(id,kind,payload,updated_at)
        VALUES(?,'sim-plan-binding',?,?)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`,
      )
      .run(bindingId, payload, updatedAt);
  }
  deletePlanBindingsForAccount(accountId: string) {
    this.db
      .prepare(
        `DELETE FROM records WHERE kind='sim-plan-binding'
        AND json_extract(payload,'$.accountId')=?`,
      )
      .run(accountId);
  }
}
