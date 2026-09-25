import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cryptoPair, cryptoSymbolSchema } from "~/lib/market/crypto";
import { get, put, sqlite } from "../db";
import {
  BinanceApiError,
  BinanceSimClient,
  type BinanceCallEvidence,
} from "../data-sources/binance/binance-private";
import { readBinanceSimCredential } from "../infra/crypto-connectivity";

/**
 * Binance simulated trading (Demo Mode / Spot Testnet). Off by default and
 * enabling sends nothing. Every order is previewed first; confirmation
 * consumes a 60-second one-time id before any request, is never retried, and
 * an uncertain outcome is reported as unknown rather than guessed. Nothing is
 * written to the A-share trade ledger.
 */
const configId = "crypto-demo-config";
const diagnosticsId = "crypto-demo-diagnostics";
export const cryptoDemoEnabled = () =>
  get<{ enabled: boolean }>(configId)?.enabled === true;
export function setCryptoDemoEnabled(enabled: boolean) {
  put("crypto-demo-config", configId, { enabled });
  return { enabled };
}
export const cryptoDemoDiagnostics = () =>
  get<BinanceCallEvidence[]>(diagnosticsId) ?? [];
const retain = (entry: BinanceCallEvidence) =>
  put(
    "crypto-demo-diagnostics",
    diagnosticsId,
    [...cryptoDemoDiagnostics(), entry].slice(-20),
  );

async function client() {
  if (!cryptoDemoEnabled()) throw new Error("数字货币模拟盘未开启");
  return new BinanceSimClient(await readBinanceSimCredential(), retain);
}

const balances = z.object({
  balances: z.array(
    z.object({ asset: z.string(), free: z.string(), locked: z.string() }),
  ),
});
export async function cryptoDemoAccount() {
  const c = await client();
  const account = balances.parse(await c.account());
  return {
    balances: account.balances.filter(
      (b) => Number(b.free) > 0 || Number(b.locked) > 0,
    ),
    openOrders: z
      .array(
        z.object({
          symbol: z.string(),
          orderId: z.number(),
          side: z.string(),
          type: z.string(),
          price: z.string(),
          origQty: z.string(),
          executedQty: z.string(),
          status: z.string(),
          time: z.number(),
        }),
      )
      .parse(await c.openOrders()),
  };
}
export async function cryptoDemoTrades(symbol: string) {
  const c = await client();
  return z
    .array(
      z.object({
        id: z.number(),
        orderId: z.number(),
        price: z.string(),
        qty: z.string(),
        quoteQty: z.string(),
        commission: z.string(),
        commissionAsset: z.string(),
        time: z.number(),
        isBuyer: z.boolean(),
      }),
    )
    .parse(await c.myTrades(cryptoPair(cryptoSymbolSchema.parse(symbol))));
}

const decimal = z.string().trim().regex(/^\d+(\.\d+)?$/, "须为正数");
export const cryptoDemoOrderSchema = z
  .object({
    symbol: cryptoSymbolSchema,
    side: z.enum(["BUY", "SELL"]),
    type: z.enum(["LIMIT", "MARKET"]),
    quantity: decimal,
    price: decimal.optional(),
  })
  .strict()
  .refine((o) => o.type === "MARKET" || !!o.price, "限价单需要价格");
export type CryptoDemoOrder = z.infer<typeof cryptoDemoOrderSchema>;

/** Whether `value` is a whole multiple of `step` (decimal strings, exact). */
export function onStep(value: string, step: string) {
  const scale = Math.max(
    value.split(".")[1]?.length ?? 0,
    step.split(".")[1]?.length ?? 0,
  );
  const units = (s: string) => {
    const [int, frac = ""] = s.split(".");
    return BigInt(int + frac.padEnd(scale, "0"));
  };
  const s = units(step);
  return s === 0n || units(value) % s === 0n;
}

const filters = z.object({
  symbols: z
    .array(
      z.object({
        symbol: z.string(),
        status: z.string(),
        baseAsset: z.string(),
        quoteAsset: z.string(),
        filters: z.array(z.record(z.string(), z.unknown())),
      }),
    )
    .min(1),
});
/** Exchange filter checks; returns the problems found (empty when valid). */
export function orderProblems(
  order: CryptoDemoOrder,
  info: z.infer<typeof filters>["symbols"][number],
  referencePrice: number,
) {
  const problems: string[] = [];
  const f = (type: string) =>
    info.filters.find((x) => x.filterType === type) as
      | Record<string, string>
      | undefined;
  if (info.status !== "TRADING") problems.push(`交易对状态 ${info.status}`);
  const lot = f(order.type === "MARKET" ? "MARKET_LOT_SIZE" : "LOT_SIZE") ?? f("LOT_SIZE");
  if (lot) {
    const q = Number(order.quantity);
    if (q < Number(lot.minQty)) problems.push(`数量低于最小 ${lot.minQty}`);
    if (Number(lot.maxQty) > 0 && q > Number(lot.maxQty))
      problems.push(`数量高于最大 ${lot.maxQty}`);
    if (Number(lot.stepSize) > 0 && !onStep(order.quantity, lot.stepSize!))
      problems.push(`数量须为 ${lot.stepSize} 的整数倍`);
  }
  const tick = f("PRICE_FILTER");
  if (order.type === "LIMIT" && tick && order.price) {
    if (Number(tick.tickSize) > 0 && !onStep(order.price, tick.tickSize!))
      problems.push(`价格须为 ${tick.tickSize} 的整数倍`);
    if (Number(order.price) < Number(tick.minPrice))
      problems.push(`价格低于最小 ${tick.minPrice}`);
  }
  const notional = f("NOTIONAL") ?? f("MIN_NOTIONAL");
  const value =
    Number(order.quantity) *
    (order.type === "LIMIT" ? Number(order.price) : referencePrice);
  if (notional && value < Number(notional.minNotional))
    problems.push(`名义金额 ${value.toFixed(4)} 低于最小 ${notional.minNotional}`);
  return { problems, notional: value };
}

type Pending = {
  order: CryptoDemoOrder;
  network: string;
  expires: number;
  state: "pending" | "attempted";
};
export async function previewCryptoDemoOrder(input: unknown) {
  const order = cryptoDemoOrderSchema.parse(input);
  const c = await client();
  const pair = cryptoPair(order.symbol);
  const info = filters.parse(await c.exchangeInfo(pair)).symbols[0]!;
  const price = Number(
    z.object({ price: z.string() }).parse(await c.price(pair)).price,
  );
  const account = balances.parse(await c.account());
  const free = (asset: string) =>
    Number(account.balances.find((b) => b.asset === asset)?.free ?? 0);
  const { problems, notional } = orderProblems(order, info, price);
  if (order.side === "BUY" && notional > free(info.quoteAsset))
    problems.push(`可用 ${info.quoteAsset} 不足（需约 ${notional.toFixed(4)}）`);
  if (order.side === "SELL" && Number(order.quantity) > free(info.baseAsset))
    problems.push(`可用 ${info.baseAsset} 不足`);
  if (problems.length) return { id: null, problems, referencePrice: price, notional };
  const { network } = await readBinanceSimCredential();
  const id = `crypto-demo-order-${randomUUID()}`;
  put<Pending>("crypto-demo-order", id, {
    order,
    network,
    expires: Date.now() + 60000,
    state: "pending",
  });
  return { id, problems, referencePrice: price, notional, network };
}

export async function confirmCryptoDemoOrder(id: string) {
  if (!/^crypto-demo-order-[\da-f-]{36}$/.test(id))
    throw new Error("无效委托确认编号");
  const c = await client();
  const pending = sqlite()
    .transaction(() => {
      const p = get<Pending>(id);
      if (!p || p.state !== "pending" || p.expires < Date.now())
        throw new Error("委托已确认或已过期，请重新预览");
      // Consumed before I/O: reload, double-click or retry cannot re-send.
      put("crypto-demo-order", id, { ...p, state: "attempted" });
      return p;
    })
    .immediate();
  if ((await readBinanceSimCredential()).network !== pending.network)
    throw new Error("预览后 Key 所属网络已变化，本单未发送，请重新预览");
  try {
    const result = await c.newOrder({
      symbol: cryptoPair(pending.order.symbol),
      side: pending.order.side,
      type: pending.order.type,
      quantity: pending.order.quantity,
      price: pending.order.price,
      // Binance rejects a repeated client id, a second guard against resends.
      clientOrderId: id.slice(-36).replaceAll("-", ""),
    });
    return { outcome: "accepted" as const, response: result };
  } catch (error) {
    const unknown = error instanceof BinanceApiError && error.outcomeUnknown;
    return {
      outcome: unknown ? ("unknown" as const) : ("rejected" as const),
      message: error instanceof Error ? error.message : "下单失败",
    };
  }
}

export async function cancelCryptoDemoOrder(input: unknown) {
  const { symbol, orderId } = z
    .object({ symbol: cryptoSymbolSchema, orderId: z.string().regex(/^\d+$/) })
    .parse(input);
  const c = await client();
  return c.cancelOrder(cryptoPair(symbol), orderId);
}
