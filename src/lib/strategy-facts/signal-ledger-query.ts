import { z } from "zod";
import { symbolSchema } from "../domain";
import { deliveryTierSchema } from "./notification-policy";

export const ledgerDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "日期无效");
const dates = {
  from: ledgerDateSchema.optional(),
  to: ledgerDateSchema.optional(),
};
const ordered = (value: { from?: string; to?: string }) =>
  !value.from || !value.to || value.from <= value.to;
const rangeError = { message: "开始日期不能晚于结束日期", path: ["to"] };
export const ledgerHistorySchema = z
  .object({
    ...dates,
    symbol: symbolSchema.optional(),
    strategy: z.enum(["czsc", "dual-breakout"]).optional(),
    direction: z.enum(["long", "short"]).optional(),
    quality: z.string().trim().min(1).max(100).optional(),
    horizon: z.union([z.literal(5), z.literal(10), z.literal(20)]).default(5),
    state: z.enum(["pending", "valid", "blank"]).optional(),
    cursor: z
      .object({
        date: ledgerDateSchema,
        symbol: symbolSchema,
        id: z.string().min(1).max(300),
        filter: z.string().length(64),
      })
      .optional(),
  })
  .refine(ordered, rangeError);
export type LedgerHistoryInput = z.input<typeof ledgerHistorySchema>;
export const ledgerRunsSchema = z
  .object({
    ...dates,
    status: z
      .enum(["running", "complete", "partial", "failed", "cancelled"])
      .optional(),
    cursor: z
      .object({ date: ledgerDateSchema, filter: z.string().length(64) })
      .optional(),
  })
  .refine(ordered, rangeError);
export const ledgerDecisionsSchema = z
  .object({
    ...dates,
    symbol: symbolSchema.optional(),
    tier: deliveryTierSchema.optional(),
    cursor: z
      .object({
        at: z.number().finite(),
        id: z.string().min(1).max(300),
        filter: z.string().length(64),
      })
      .optional(),
  })
  .refine(ordered, rangeError);
export const ledgerIdSchema = z.string().min(1).max(300);
