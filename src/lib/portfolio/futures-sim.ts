import Big from "big.js";
import { z } from "zod";
import { futuresSymbolSchema, type FuturesContract } from "../market/futures";

export const futuresSimCurrencySchema = z.enum(["CNY", "USD"]);
export const futuresSimActionSchema = z.enum([
  "buy_open",
  "sell_close",
  "sell_open",
  "buy_close",
]);
export type FuturesSimCurrency = z.infer<typeof futuresSimCurrencySchema>;
export type FuturesSimAction = z.infer<typeof futuresSimActionSchema>;
export const futuresSimActionLabels = {
  buy_open: "开多",
  sell_close: "平多",
  sell_open: "开空",
  buy_close: "平空",
} as const satisfies Record<FuturesSimAction, string>;

export function futuresContractCurrency(
  contract: FuturesContract,
): FuturesSimCurrency {
  return contract.unit.includes("美元") ? "USD" : "CNY";
}

const positiveDecimal = z
  .string()
  .trim()
  .max(48)
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((value) => /[1-9]/.test(value), "数值必须大于零");
const marginRateSchema = z
  .union([positiveDecimal, z.number().finite()])
  .transform((value) => new Big(value))
  .refine(
    (rate) => rate.gte("0.05") && rate.lte("1"),
    "保证金比例须在 5% 至 100% 之间",
  )
  .transform((rate) => rate.toFixed());
const identifier = z.string().trim().min(1).max(160);
export const futuresSimAccountCreateSchema = z
  .object({
    name: z
      .string()
      .trim()
      .refine((name) => {
        const length = Array.from(name).length;
        return length >= 2 && length <= 32;
      }, "账户名称须为 2 至 32 个字符"),
    currency: futuresSimCurrencySchema,
    initialCapital: positiveDecimal,
  })
  .strict();
export const futuresSimOrderPreviewSchema = z
  .object({
    accountId: identifier,
    symbol: futuresSymbolSchema,
    action: futuresSimActionSchema,
    quantity: z.number().int().positive().safe(),
    price: positiveDecimal,
    marginRate: marginRateSchema.default("0.1"),
  })
  .strict();
export const futuresSimOrderConfirmSchema = futuresSimOrderPreviewSchema.extend(
  {
    clientRequestId: identifier,
  },
);

export type FuturesSimAccountCreate = z.input<
  typeof futuresSimAccountCreateSchema
>;
export type FuturesSimOrderPreview = z.input<
  typeof futuresSimOrderPreviewSchema
>;
export type FuturesSimOrderConfirm = z.input<
  typeof futuresSimOrderConfirmSchema
>;

export interface FuturesSimPosition {
  symbol: string;
  name: string;
  side: "long" | "short";
  quantity: number;
  contractMultiplier: number;
  /** Entry notional of all remaining lots, before display rounding. */
  costBasis: string;
  /** Exact rational cost basis (reduced numerator/denominator) across partial closes. */
  costBasisRatio?: { num: string; den: string };
  avgEntryPrice: string;
  margin: string;
  marginRate: string;
}

export interface FuturesSimTrade {
  id: string;
  clientRequestId: string;
  symbol: string;
  name: string;
  action: FuturesSimAction;
  quantity: number;
  /** Receipts recorded before lot-based accounting lack these two fields. */
  contractMultiplier?: number;
  grossPnl?: string;
  price: string;
  notional: string;
  /** Positive when frozen, negative when released. */
  marginDelta: string;
  fee: string;
  realizedPnl: string;
  executedAt: number;
}

export interface FuturesSimAccountSummary {
  id: string;
  name: string;
  currency: FuturesSimCurrency;
  initialCapital: string;
  cash: string;
  frozenMargin: string;
  realizedPnl: string;
  positions: FuturesSimPosition[];
  trades: FuturesSimTrade[];
  createdAt: number;
  updatedAt: number;
}

export interface FuturesSimOrderPreviewResult {
  accountId: string;
  symbol: string;
  name: string;
  currency: FuturesSimCurrency;
  action: FuturesSimAction;
  quantity: number;
  price: string;
  contractMultiplier: number;
  marginRate: string;
  notional: string;
  requiredMargin: string;
  releasedMargin: string;
  fee: string;
  grossPnl: string;
  estimatedPnl: string;
  cashBefore: string;
  cashAfter: string;
  positionQtyBefore: number;
  positionQtyAfter: number;
}
