import { z } from "zod";
import { executionCostsSchema } from "trading-strategy-core/costs";
export type { Bar } from "trading-strategy-core/bars";
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const time = Date.parse(date);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === date
    );
  }, "日期无效");
export const backtestRequestSchema = z
  .object({
    symbol: z.string().min(1).max(64),
    start: dateSchema,
    end: dateSchema,
    initial: z.number().finite().min(1000).max(1e9).default(100000),
    costs: executionCostsSchema.default({}),
  })
  .strict();
export const maBaselineInputSchema = backtestRequestSchema
  .extend({
    symbol: z
      .string()
      .regex(/^(sh60|sz00)\d{4}$/, "基线当前仅支持沪深主板 A 股"),
  })
  .refine((v) => v.start <= v.end, "开始日期不能晚于结束日期");
export type BacktestRequest = z.infer<typeof backtestRequestSchema>;
export type MaBaselineInput = z.infer<typeof maBaselineInputSchema>;
export type BaselineOrder = {
  id: number;
  side: "buy" | "sell";
  signalAt: string;
  status: "pending" | "filled" | "rejected";
  attempts: number;
  reason: string | null;
};
export type BaselineFill = {
  orderId: number;
  signalAt: string;
  barEnd: string;
  executedAt: string;
  side: "buy" | "sell";
  price: number;
  shares: number;
  fee: number;
  cashAfter: number;
  sharesAfter: number;
};
/** Strategy calculation has no account, order book, IO or execution access. */
export type SignalSeries = {
  id: string;
  warmupBars: number;
  values: Int8Array;
};
export type CashEquityAccount = {
  cash: number;
  shares: number;
  buyDay: string;
};
