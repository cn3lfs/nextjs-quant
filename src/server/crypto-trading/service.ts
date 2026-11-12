import {
  credentialRevisionKey,
  type AccountReadContext,
} from "./account-model";
import Big from "big.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { cryptoDualMa } from "trading-strategies";
import { atomic, get, list, put, remove, sqlite } from "../db";
import { acquireScheduler, processAlive } from "../infra/lease";
import { readSecret, saveSecret } from "../vault";
import { createSpotAdapter } from "./adapter";
import {
  accountId,
  configSchema,
  floorStep,
  orderQuantity,
  symbols,
  terminal,
  type BotState,
  type Config,
  type Credential,
  type Execution,
  type Snapshot,
  type SpotAdapter,
  type Symbol,
} from "./model";

const botKind = "crypto-bot";
const botKey = (id: string) => `crypto-bot-${id}`;
const credentialKey = (id: string) => `crypto-bot-key-${id}`;
const idSchema = z.enum([
  "binance-demo",
  "binance-testnet",
  "okx-demo",
  "bybit-demo",
]);
const scope = globalThis as typeof globalThis & {
  cryptoAccountLocks?: Map<string, Promise<unknown>>;
  cryptoLastTicks?: Map<string, number>;
};
const locks = (scope.cryptoAccountLocks ??= new Map());
const lastTicks = (scope.cryptoLastTicks ??= new Map());
class AccountBusyError extends Error {}
async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const owner = randomUUID(),
        key = `crypto-account-writer-${id}`;
      atomic(() => {
        const current = get<{ owner: string; pid: number }>(key);
        if (current && processAlive(current.pid))
          throw new AccountBusyError("该账户正在其他宿主执行操作，请稍后重试");
        put("crypto-account-writer", key, { owner, pid: process.pid });
      });
      try {
        return await action();
      } finally {
        atomic(() => {
          if (get<{ owner: string }>(key)?.owner === owner) remove(key);
        });
      }
    });
  locks.set(id, next);
  try {
    return await next;
  } finally {
    if (locks.get(id) === next) locks.delete(id);
  }
}
function bot(id: string): BotState {
  const value = get<BotState>(botKey(idSchema.parse(id)));
  if (!value) throw new Error("请先保存策略配置");
  return value;
}
function persist(value: BotState) {
  value.updatedAt = Date.now();
  return put(botKind, botKey(value.id), value);
}
function orders(id: string): Execution[] {
  // Recovery must see every unresolved intent, not a UI history limit.
  return (
    sqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind=? ORDER BY updated_at ASC, id ASC",
      )
      .all(`crypto-orders-${id}`) as { payload: string }[]
  ).map((row) => JSON.parse(row.payload) as Execution);
}
function saveOrder(id: string, order: Execution) {
  order.updatedAt = Date.now();
  put(`crypto-orders-${id}`, `crypto-order-${id}-${order.clientId}`, order);
}
const unresolved = (order: Execution) => !terminal(order.state);
async function adapter(value: BotState) {
  const credential = await readSecret<Credential>(credentialKey(value.id));
  if (!credential) throw new Error("请先保存模拟账户凭证");
  return createSpotAdapter(value.config, credential);
}
export async function cryptoBotStatus(id: string) {
  idSchema.parse(id);
  return {
    bot: get<BotState>(botKey(id)) ?? null,
    credentialConfigured:
      get<boolean>(`${credentialKey(id)}-configured`) === true,
    orders: orders(id).slice(-200).reverse(),
  };
}
export async function saveCryptoBot(input: Config) {
  const config = configSchema.parse(input),
    id = accountId(config);
  return locked(id, async () =>
    atomic(() => {
      const current = get<BotState>(botKey(id));
      if (current?.status === "running" || orders(id).some(unresolved))
        throw new Error("请先暂停并等待未完成订单对账");
      const value: BotState = current
        ? { ...current, config, lastCandles: {}, error: null }
        : {
            id,
            config,
            status: "stopped",
            initialUsdt: null,
            positions: { BTCUSDT: "0", ETHUSDT: "0" },
            baseline: {},
            lastCandles: {},
            indicators: {},
            error: null,
            updatedAt: Date.now(),
          };
      return persist(value);
    }),
  );
}
export async function saveCryptoBotCredential(input: {
  id: string;
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}) {
  const value = z
    .object({
      id: idSchema,
      apiKey: z.string().trim().min(1).max(256),
      apiSecret: z.string().trim().min(1).max(256),
      passphrase: z.string().trim().min(1).max(256).optional(),
    })
    .strict()
    .parse(input);
  return locked(value.id, async () => {
    const current = bot(value.id);
    if (current.status !== "stopped" || orders(value.id).some(unresolved))
      throw new Error("凭证变更须停止策略且完成订单对账");
    if (current.config.venue === "okx" && !value.passphrase)
      throw new Error("OKX需要Passphrase");
    if (current.initialUsdt !== null)
      throw new Error("已启动账户不能替换凭证，以免混用资金基线与历史成交");
    await saveSecret(credentialKey(value.id), {
      apiKey: value.apiKey,
      apiSecret: value.apiSecret,
      ...(value.passphrase ? { passphrase: value.passphrase } : {}),
    });
    atomic(() => {
      put(
        "crypto-credential-revision",
        credentialRevisionKey(value.id),
        randomUUID(),
      );
      put(
        "crypto-credential-status",
        `${credentialKey(value.id)}-configured`,
        true,
      );
    });
    return { configured: true };
  });
}
/** Internal read context: releases the account writer lock before historical network IO. */
export async function getCryptoAccountReadContext(
  id: string,
): Promise<AccountReadContext> {
  idSchema.parse(id);
  return locked(id, async () => {
    const current = bot(id);
    const credential = await readSecret<Credential>(credentialKey(id));
    if (!credential) throw new Error("请先保存模拟账户凭证");
    const revision = atomic(() => {
      const key = credentialRevisionKey(id);
      return (
        get<string>(key) ?? put("crypto-credential-revision", key, randomUUID())
      );
    });
    return { config: current.config, credential, revision };
  });
}
export async function diagnoseCryptoBot(id: string) {
  idSchema.parse(id);
  return locked(id, async () => (await adapter(bot(id))).snapshot());
}
function balances(snapshot: Snapshot) {
  return Object.fromEntries(
    snapshot.balances.map((x) => [x.asset, new Big(x.total).toFixed()]),
  );
}
function free(snapshot: Snapshot, asset: string) {
  return snapshot.balances.find((x) => x.asset === asset)?.free ?? "0";
}
function project(value: BotState, executions: Execution[]) {
  const expected = { ...value.baseline };
  const positions: Record<Symbol, string> = { BTCUSDT: "0", ETHUSDT: "0" };
  const seen = new Set<string>();
  const add = (asset: string, change: Big) => {
    expected[asset] = new Big(expected[asset] ?? "0").plus(change).toFixed();
  };
  for (const order of executions)
    for (const fill of order.fills) {
      const key = `${order.symbol}:${fill.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const base = order.symbol.slice(0, -4),
        direction = order.side === "BUY" ? 1 : -1;
      const quantity = new Big(fill.quantity),
        cost = quantity.times(fill.price);
      add(base, quantity.times(direction));
      add("USDT", cost.times(-direction));
      add(fill.feeAsset, new Big(fill.fee).times(-1));
      positions[order.symbol] = new Big(positions[order.symbol])
        .plus(quantity.times(direction))
        .minus(fill.feeAsset === base ? fill.fee : "0")
        .toFixed();
    }
  if (Object.values(positions).some((x) => new Big(x).lt(0)))
    throw new Error("成交投影出现负持仓，请核对账户");
  return { expected, positions };
}
function checkBalances(expected: Record<string, string>, snapshot: Snapshot) {
  const actual = balances(snapshot);
  for (const asset of new Set([
    "USDT",
    "BTC",
    "ETH",
    ...Object.keys(expected),
  ])) {
    if (!new Big(actual[asset] ?? "0").eq(expected[asset] ?? "0"))
      throw new Error(
        `账户${asset}余额与策略成交不一致，已暂停；请核对外部交易或转账`,
      );
  }
}
async function reconcile(value: BotState, exchange: SpotAdapter) {
  for (const order of orders(value.id).filter(unresolved)) {
    const remote = await exchange.reconcile(order);
    if (!remote) throw new Error("订单结果尚未确认，不会重复发送，请继续对账");
    const merged = new Map(order.fills.map((fill) => [fill.id, fill]));
    for (const fill of remote.fills) {
      const existing = merged.get(fill.id);
      if (
        existing &&
        (!new Big(existing.quantity).eq(fill.quantity) ||
          !new Big(existing.price).eq(fill.price) ||
          !new Big(existing.fee).eq(fill.fee) ||
          existing.feeAsset !== fill.feeAsset)
      )
        throw new Error("交易所成交证据发生变化，已暂停核对");
      merged.set(fill.id, fill);
    }
    const fills = [...merged.values()],
      filled = fills.reduce((sum, fill) => sum.plus(fill.quantity), new Big(0));
    if (
      remote.executedQuantity !== undefined &&
      (new Big(remote.executedQuantity).lt(order.executedQuantity ?? "0") ||
        filled.gt(remote.executedQuantity))
    )
      throw new Error("交易所累计成交数量倒退，已暂停核对");
    if (
      terminal(remote.state) &&
      (remote.executedQuantity === undefined ||
        !filled.eq(remote.executedQuantity))
    )
      throw new Error("终态订单成交明细不完整，等待核对");
    atomic(() =>
      saveOrder(value.id, { ...order, ...remote, fills, error: undefined }),
    );
  }
  const executions = orders(value.id),
    projection = project(value, executions);
  atomic(() => {
    const current = bot(value.id);
    persist({ ...current, positions: projection.positions });
  });
  if (executions.some(unresolved)) return null;
  const snapshot = await exchange.snapshot();
  if (value.initialUsdt !== null) checkBalances(projection.expected, snapshot);
  if (snapshot.openOrders.length)
    throw new Error("账户存在未完成订单，请核对后再启动");
  return snapshot;
}
export async function controlCryptoBot(input: {
  id: string;
  action: "start" | "pause" | "stop";
}) {
  const { id, action } = z
    .object({ id: idSchema, action: z.enum(["start", "pause", "stop"]) })
    .parse(input);
  const commandId = randomUUID();
  atomic(() => put("crypto-command", `crypto-command-${id}`, commandId));
  // Stop admission immediately, even while an account's current HTTP query is waiting.
  if (action !== "start")
    atomic(() => {
      const current = bot(id);
      persist({
        ...current,
        status: action === "stop" ? "stopped" : "paused",
        lastCandles: {},
      });
    });
  if (action !== "start") return bot(id);
  return locked(id, async () => {
    const current = bot(id),
      exchange = await adapter(current);
    const snapshot = await reconcile(current, exchange);
    if (!snapshot) throw new Error("请等待未完成订单对账");
    if (new Big(free(snapshot, "USDT")).lte(0))
      throw new Error("模拟账户USDT余额不足");
    return atomic(() => {
      if (get<string>(`crypto-command-${id}`) !== commandId)
        throw new Error("启停请求已被更新，请刷新状态");
      return persist({
        ...bot(id),
        status: "running",
        initialUsdt: current.initialUsdt ?? free(snapshot, "USDT"),
        baseline:
          current.initialUsdt === null ? balances(snapshot) : current.baseline,
        lastCandles: {},
        error: null,
      });
    });
  });
}
export async function cancelCryptoBotOrder(input: {
  id: string;
  clientId: string;
}) {
  const { id, clientId } = z
    .object({
      id: idSchema,
      clientId: z
        .string()
        .regex(/^[a-zA-Z0-9]+$/)
        .max(36),
    })
    .parse(input);
  return locked(id, async () => {
    const value = bot(id),
      order = orders(id).find((x) => x.clientId === clientId);
    if (!order || !unresolved(order)) throw new Error("没有可撤销的订单");
    const exchange = await adapter(value);
    await exchange.cancel(order);
    await reconcile(value, exchange);
    return { requested: true };
  });
}
async function evaluate(
  value: BotState,
  exchange: SpotAdapter,
  snapshot: Snapshot,
  symbol: Symbol,
  now: number,
  reset: boolean,
) {
  const { config } = value,
    duration = config.minutes * 60000;
  const candles = await exchange.candles(
    symbol,
    config.minutes,
    config.slow + 1,
  );
  if (candles.length < config.slow + 1)
    throw new Error(`${symbol}已收盘K线不足`);
  const selected = candles.slice(-(config.slow + 1));
  if (
    selected.some(
      (c, i) =>
        !Number.isFinite(c.time) ||
        !Number.isFinite(c.close) ||
        c.close <= 0 ||
        c.time % duration !== 0 ||
        c.time + duration > now ||
        (i > 0 && c.time - selected[i - 1]!.time !== duration),
    )
  )
    throw new Error(`${symbol}K线未完成、重复或不连续`);
  const latest = selected.at(-1)!.time;
  if (now - latest - duration > duration + 90000)
    throw new Error(`${symbol}行情已过期`);
  const indicator = cryptoDualMa(
    selected.map((x) => x.close),
    config.fast,
    config.slow,
  );
  if (!indicator) return;
  const prior = value.lastCandles[symbol];
  atomic(() => {
    const current = bot(value.id);
    persist({
      ...current,
      lastCandles: { ...current.lastCandles, [symbol]: latest },
      indicators: {
        ...current.indicators,
        [symbol]: { ...indicator, candleTime: latest },
      },
    });
  });
  if (
    now - latest - duration > 90000 ||
    reset ||
    prior === undefined ||
    prior === latest ||
    latest - prior !== duration ||
    indicator.signal === "HOLD"
  )
    return;
  const holding = new Big(value.positions[symbol]);
  const price = await exchange.price(symbol),
    rules = await exchange.rules(symbol);
  const quantizedHolding = new Big(floorStep(holding.toFixed(), rules.step));
  const tradable =
    quantizedHolding.gte(rules.min) &&
    quantizedHolding.times(price).gte(rules.minValue) &&
    quantizedHolding.gt(0);
  if (
    (indicator.signal === "BUY" && tradable) ||
    (indicator.signal === "SELL" && !tradable)
  ) {
    if (holding.gt(0) && !tradable)
      atomic(() => {
        const current = bot(value.id);
        persist({
          ...current,
          indicators: {
            ...current.indicators,
            [symbol]: {
              ...indicator,
              candleTime: latest,
              reason: "零碎持仓低于平台交易门槛，保留账本",
            },
          },
        });
      });
    return;
  }
  const budget = new Big(value.initialUsdt!)
    .times(config.allocation)
    .times("0.99");
  const availableBudget = budget.lt(free(snapshot, "USDT"))
    ? budget
    : new Big(free(snapshot, "USDT")).times("0.99");
  const quoteBudget = availableBudget.round(2, 0).toFixed(2);
  const amount =
    indicator.signal === "BUY" ? new Big(quoteBudget).div(price) : holding;
  if (
    indicator.signal === "SELL" &&
    amount.gt(free(snapshot, symbol.slice(0, -4)))
  )
    throw new Error("可用持仓不足，账户可能被外部操作");
  if (
    indicator.signal === "BUY" &&
    (new Big(quoteBudget).lt(rules.minValue) ||
      (rules.maxValue !== undefined && new Big(quoteBudget).gt(rules.maxValue)))
  )
    throw new Error("买入预算不满足平台名义金额规则");
  const quantity = orderQuantity(amount.toFixed(), price, rules);
  const clientId =
    "qm" +
    createHash("sha256")
      .update(`${value.id}:${symbol}:${latest}:${indicator.signal}`)
      .digest("hex")
      .slice(0, 30);
  const order: Execution = {
    clientId,
    symbol,
    side: indicator.signal,
    quantity,
    ...(indicator.signal === "BUY" ? { quoteBudget } : {}),
    state: "INTENT",
    fills: [],
    createdAt: now,
    updatedAt: now,
    candleTime: latest,
    decision: {
      strategyId: "crypto-dual-ma-v1",
      version: 1,
      config: { ...config },
      indicators: { ...indicator, candleTime: latest },
    },
  };
  const admitted = atomic(() => {
    if (
      bot(value.id).status !== "running" ||
      orders(value.id).some(unresolved) ||
      get(`crypto-order-${value.id}-${clientId}`)
    )
      return false;
    saveOrder(value.id, order);
    return true;
  });
  if (!admitted) return;
  try {
    const result = await exchange.place(order);
    atomic(() =>
      saveOrder(value.id, {
        ...order,
        exchangeId: result.exchangeId,
        raw: result.raw,
        state: "SUBMITTED",
      }),
    );
  } catch (error) {
    // An intent remains unresolved even on a local error. Only exchange facts resolve it.
    const message = error instanceof Error ? error.message : "下单失败";
    const outcomeUnknown = !(
      error instanceof Error &&
      "outcomeUnknown" in error &&
      error.outcomeUnknown === false
    );
    atomic(() => {
      saveOrder(value.id, {
        ...order,
        state: outcomeUnknown ? "UNKNOWN" : "REJECTED",
        error: message,
      });
      const current = bot(value.id);
      persist({ ...current, status: "paused", error: message });
    });
  }
}
export async function tickCryptoBots() {
  if (!acquireScheduler()) return;
  for (const saved of list<BotState>(botKind, 10)) {
    try {
      await locked(saved.id, async () => {
        let value = bot(saved.id);
        if (value.status !== "running" && !orders(value.id).some(unresolved))
          return;
        const now = Date.now(),
          previous = lastTicks.get(value.id);
        const reset = previous === undefined || now - previous > 90000;
        lastTicks.set(value.id, now);
        try {
          const exchange = await adapter(value);
          let snapshot = await reconcile(value, exchange);
          value = bot(value.id);
          if (!snapshot || value.status !== "running") return;
          for (const symbol of symbols) {
            await evaluate(value, exchange, snapshot, symbol, now, reset);
            value = bot(value.id);
            if (value.status !== "running") break;
            snapshot = await reconcile(value, exchange);
            value = bot(value.id);
            if (!snapshot) break;
          }
        } catch (error) {
          atomic(() => {
            value = bot(saved.id);
            persist({
              ...value,
              status: value.status === "stopped" ? "stopped" : "paused",
              error: error instanceof Error ? error.message : "交易运行失败",
            });
          });
        }
      });
    } catch (error) {
      if (!(error instanceof AccountBusyError)) throw error;
    }
  }
}
