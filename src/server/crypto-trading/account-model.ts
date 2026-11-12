import { z } from "zod";
import type { Balance, Config, Credential, SpotAdapter, Symbol } from "./model";
export const cryptoAccountIdSchema = z.enum([
  "binance-demo",
  "binance-testnet",
  "okx-demo",
  "bybit-demo",
]);
export type PlatformTrade = {
  id: string;
  orderId: string;
  clientOrderId?: string;
  symbol: Symbol;
  side: "BUY" | "SELL";
  time: number;
  quantity: string;
  price: string;
  quoteQuantity: string;
  fee: string;
  feeAsset: string;
  raw?: unknown;
};
export type AccountHistoryAdapter = SpotAdapter & {
  tradeHistory(
    symbol: Symbol,
    from: number,
    to: number,
  ): Promise<PlatformTrade[]>;
};
export type AccountReadContext = {
  config: Config;
  credential: Credential;
  revision: string;
};
export const credentialRevisionKey = (id: string) =>
  `crypto-account-credential-revision-${id}`;
export type AccountPosition = {
  symbol: Symbol;
  total: string;
  free: string;
  locked: string;
  price: string | null;
  marketValue: string | null;
  priceAt: number | null;
};
export type AccountSnapshot = {
  at: number;
  balances: Balance[];
  positions: AccountPosition[];
  warnings: string[];
};
export type CompletedRange = { symbol: Symbol; from: number; to: number };
export type AccountSyncState = {
  revision: string;
  status: "running" | "success" | "partial" | "failed";
  startedAt: number;
  finishedAt: number | null;
  lastSuccessAt: number | null;
  lastIncrementalTo: number | null;
  requestedFrom: number;
  requestedTo: number;
  completedRanges: CompletedRange[];
  warnings: string[];
  error: string | null;
};
export type AccountTradeRow = PlatformTrade & {
  source: "strategy" | "platform";
};
export const accountViewSchema = z
  .object({
    id: cryptoAccountIdSchema,
    symbol: z.enum(["BTCUSDT", "ETHUSDT"]).optional(),
    side: z.enum(["BUY", "SELL"]).optional(),
    source: z.enum(["strategy", "platform"]).optional(),
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().positive().optional(),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (x) => x.from === undefined || x.to === undefined || x.from < x.to,
    "起始时间须早于结束时间",
  );
export type AccountViewInput = z.input<typeof accountViewSchema>;
export type AccountView = {
  snapshot: AccountSnapshot | null;
  sync: AccountSyncState | null;
  rows: AccountTradeRow[];
  total: number;
  page: number;
  pageSize: number;
};
export const accountSyncSchema = z
  .object({
    id: cryptoAccountIdSchema,
    from: z.number().int().nonnegative().optional(),
    to: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (x) => x.from === undefined || x.to === undefined || x.from < x.to,
    "起始时间须早于结束时间",
  );
export type AccountSyncInput = z.input<typeof accountSyncSchema>;
