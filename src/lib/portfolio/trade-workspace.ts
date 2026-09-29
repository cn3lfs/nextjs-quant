import { z } from "zod";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "日期无效");
export const tradeWorkspaceFilters = z.object({
  symbol: z
    .string()
    .trim()
    .regex(/^(sh|sz|bj)\d{6}$/)
    .optional(),
  from: date.optional(),
  to: date.optional(),
  side: z.enum(["buy", "sell"]).optional(),
  linked: z.boolean().optional(),
  query: z.string().trim().max(100).default(""),
});
export const tradeWorkspacePageSchema = tradeWorkspaceFilters
  .extend({
    cursor: z.string().max(2048).optional(),
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine(
    (input) => !input.from || !input.to || input.from <= input.to,
    "起始日期不能晚于截止日期",
  );
export const tradeWorkspaceId = z.string().uuid();
export const tradeSignalOptionsSchema = z.object({
  symbol: z.string().regex(/^(sh|sz|bj)\d{6}$/),
  date,
  query: z.string().trim().max(100).default(""),
  cursor: z.string().max(2048).optional(),
});
export const tradePositionPageSchema = z.object({
  page: z.number().int().min(1).max(100000).default(1),
  query: z.string().trim().max(100).default(""),
});
export const tradeAdjustmentPageSchema = z.object({
  symbol: z
    .string()
    .regex(/^(sh|sz|bj)\d{6}$/)
    .optional(),
  cursor: z.string().max(2048).optional(),
});
export type TradeWorkspaceInput = z.infer<typeof tradeWorkspacePageSchema>;
export type TradeWorkspaceRow = {
  id: string;
  symbol: string;
  date: string;
  createdAt: number;
  side: "buy" | "sell";
  price: number;
  quantity: number;
  fees: number;
  signalId: string | null;
  note: string;
};
