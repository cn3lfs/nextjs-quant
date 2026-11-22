import { z } from "zod";
import Big from "big.js";
export const venueSchema = z.enum(["binance", "okx", "bybit"]);
export type Venue = z.infer<typeof venueSchema>;
export const symbols = ["BTCUSDT", "ETHUSDT"] as const;
export type Symbol = (typeof symbols)[number];
export const configSchema = z
  .object({
    venue: venueSchema,
    network: z.enum(["demo", "testnet"]).default("demo"),
    minutes: z.union([z.literal(15), z.literal(60)]).default(60),
    fast: z.number().int().min(1).max(199).default(5),
    slow: z.number().int().min(2).max(200).default(20),
    allocation: z.number().positive().max(0.4).default(0.4),
  })
  .refine(
    (x) => x.fast < x.slow && (x.venue === "binance" || x.network === "demo"),
    "均线或模拟环境无效",
  );
export type Config = z.infer<typeof configSchema>;
export type Credential = {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
};
export type Balance = { asset: string; free: string; total: string };
export type Rules = {
  step: string;
  min: string;
  max: string;
  minValue: string;
  maxValue?: string;
};
export type Candle = { time: number; close: number };
export type Fill = {
  id: string;
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string;
};
export type Order = {
  clientId: string;
  symbol: Symbol;
  side: "BUY" | "SELL";
  quantity: string;
  /** BUY quote spend cap; quantity remains a preflight base estimate. */
  quoteBudget?: string;
  state: string;
  exchangeId?: string;
  executedQuantity?: string;
  fills: Fill[];
  raw?: unknown;
};
export const terminal = (state: string) =>
  [
    "FILLED",
    "CANCELED",
    "REJECTED",
    "EXPIRED",
    "EXPIRED_IN_MATCH",
    "Filled",
    "Cancelled",
    "PartiallyFilledCanceled",
    "Rejected",
    "Deactivated",
    "filled",
    "canceled",
  ].includes(state);
export function floorStep(value: string, step: string) {
  return new Big(value).div(step).round(0, 0).times(step).toFixed();
}
export function orderQuantity(value: string, price: string, rules: Rules) {
  const quantity = floorStep(value, rules.step);
  if (
    new Big(quantity).lt(rules.min) ||
    new Big(quantity).gt(rules.max) ||
    new Big(quantity).times(price).lt(rules.minValue) ||
    (rules.maxValue !== undefined &&
      new Big(quantity).times(price).gt(rules.maxValue))
  )
    throw new Error("数量或名义金额不满足平台规则");
  return quantity;
}

export type Execution = Order & {
  attempt?: 1 | 2;
  retryOf?: string;
  createdAt: number;
  updatedAt: number;
  candleTime: number;
  decision?: {
    strategyId: string;
    version: number;
    config: Config;
    indicators: unknown;
  };
  error?: string;
};
export type Snapshot = { balances: Balance[]; openOrders: unknown[] };
export interface SpotAdapter {
  /** Venue-adjusted clock (host time + server offset). */
  serverNow(): number;
  snapshot(): Promise<Snapshot>;
  rules(symbol: Symbol): Promise<Rules>;
  candles(symbol: Symbol, minutes: 15 | 60, limit: number): Promise<Candle[]>;
  price(symbol: Symbol): Promise<string>;
  place(order: Order): Promise<{ exchangeId: string; raw: unknown }>;
  reconcile(order: Order): Promise<Order | null>;
  cancel(order: Order): Promise<void>;
}
export type BotState = {
  id: string;
  config: Config;
  status: "stopped" | "running" | "paused";
  initialUsdt: string | null;
  positions: Record<Symbol, string>;
  baseline: Record<string, string>;
  pendingRetry?: {
    clientId: string;
    symbol: Symbol;
    candleTime: number;
    side: Order["side"];
  };
  missedSignals?: {
    symbol: Symbol;
    candleTime: number;
    side: Order["side"];
    reason: string;
    at: number;
  }[];
  lastCandles: Record<string, number>;
  indicators: Record<string, unknown>;
  error: string | null;
  updatedAt: number;
};
export const accountId = (config: Pick<Config, "venue" | "network">) =>
  `${config.venue}-${config.network}`;
