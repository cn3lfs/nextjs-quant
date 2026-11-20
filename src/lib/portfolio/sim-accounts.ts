import { z } from "zod";

const name = z
  .string()
  .trim()
  .refine((value) => {
    const length = Array.from(value).length;
    return length >= 2 && length <= 32;
  }, "账户名称须为 2 至 32 个字符");
const identifier = z.string().trim().min(1).max(160);
const market = z.enum(["cn-equity", "crypto"]);
const currency = z.enum(["CNY", "USDT"]);
const executionMode = z.enum(["manual", "plan-manual", "plan-auto"]);
const decimal = z
  .string()
  .max(48)
  .regex(/^\d+(?:\.\d+)?$/)
  .refine((s) => /[1-9]/.test(s), "数值必须大于零");
const account = z.object({ accountId: identifier }).strict();

export const simAccountCreateSchema = z
  .object({
    name,
    market,
    currency: currency.optional(),
    initialCapital: decimal,
  })
  .strict()
  .refine(
    (v) =>
      !v.currency || v.currency === (v.market === "crypto" ? "USDT" : "CNY"),
    "市场与币种不匹配",
  );
export const simAccountRenameSchema = account.extend({ name });
export const simAccountDeleteSchema = account;
export const simPlanBindingSchema = account.extend({
  planId: identifier,
  autoExecute: z.boolean(),
});
export type SimPlanBindingInput = z.infer<typeof simPlanBindingSchema>;
export interface SimPlanBinding extends SimPlanBindingInput {
  updatedAt: number;
}
export const simAccountCashFlowSchema = account.extend({
  requestId: identifier,
  kind: z.enum(["deposit", "withdrawal"]),
  amount: decimal,
  note: z.string().trim().max(500).default(""),
});

const order = account.extend({
  symbol: z.string().trim().min(1).max(20),
  side: z.enum(["buy", "sell"]),
  market: market.optional(),
  currency: currency.optional(),
  quantity: decimal,
  price: decimal,
  tradeDate: z.string().date(),
  executionMode: executionMode.default("manual"),
  planId: identifier.optional(),
});
const hasProvenance = (v: z.output<typeof order>) =>
  v.executionMode === "manual" ? !v.planId : !!v.planId;
export const simOrderPreviewSchema = order.refine(
  hasProvenance,
  "手动成交不得指定 planId，计划成交必须指定 planId",
);
export const simOrderConfirmSchema = order
  .extend({ clientRequestId: identifier })
  .refine(hasProvenance, "手动成交不得指定 planId，计划成交必须指定 planId");

export const simAccountDetailQuerySchema = account.extend({
  currentTradeDate: z.string().date().optional(),
  limit: z.number().int().min(1).max(200).default(50),
  cashFlowCursor: identifier.optional(),
  tradeCursor: identifier.optional(),
});

export type SimAccountCreate = z.input<typeof simAccountCreateSchema>;
export type SimAccountRename = z.input<typeof simAccountRenameSchema>;
export type SimAccountCashFlow = z.input<typeof simAccountCashFlowSchema>;
export type SimAccountDelete = z.input<typeof simAccountDeleteSchema>;
export type SimOrderPreview = z.input<typeof simOrderPreviewSchema>;
export type SimOrderConfirm = z.input<typeof simOrderConfirmSchema>;
export type SimAccountDetailQuery = z.input<typeof simAccountDetailQuerySchema>;

export interface SimAccountSummary {
  id: string;
  name: string;
  market: z.infer<typeof market>;
  currency: z.infer<typeof currency>;
  initialCapital: string;
  cash: string;
  status: "active" | "archived";
  revision: number;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}
export interface SimPosition {
  symbol: string;
  quantity: string;
  sellableQuantity: string;
  costBasis: string;
  averageCost: string;
}
export interface SimCashFlowRow {
  accountId: string;
  id: string;
  requestId: string;
  kind: "opening" | "deposit" | "withdrawal" | "settlement";
  delta: string;
  fillId: string | null;
  occurredAt: number;
  note: string;
}
interface SimExecution {
  accountId: string;
  market: SimAccountSummary["market"];
  currency: SimAccountSummary["currency"];
  symbol: string;
  side: "buy" | "sell";
  quantity: string;
  price: string;
  tradeDate: string;
  executionMode: z.infer<typeof executionMode>;
  planId: string | null;
  gross: string;
  commission: string;
  tax: string;
  slippage: string;
  netCashDelta: string;
}
export interface SimTradeRow extends SimExecution {
  orderId: string;
  fillId: string;
  clientRequestId: string;
  executedAt: number;
}
export interface SimOrderPreviewResult extends SimExecution {
  cashBefore: string;
  cashAfter: string;
  sellableQuantityBefore: string;
}
export interface SimAccountDetail {
  account: SimAccountSummary;
  cash: string;
  currentTradeDate: string;
  positions: SimPosition[];
  cashFlows: SimCashFlowRow[];
  trades: SimTradeRow[];
  nextCashFlowCursor: string | null;
  nextTradeCursor: string | null;
}

/** Convert ledger atoms into a fixed-width decimal without a floating-point intermediate. */
export function formatSimAtoms(atoms: bigint, digits: number): string {
  if (!Number.isInteger(digits) || digits < 0 || digits > 8)
    throw new RangeError("模拟账户精度须在 0 至 8 位之间");
  const magnitude = (atoms < 0n ? -atoms : atoms)
    .toString()
    .padStart(digits + 1, "0");
  const value = digits
    ? magnitude.slice(0, -digits) + "." + magnitude.slice(-digits)
    : magnitude;
  return atoms < 0n ? "-" + value : value;
}
