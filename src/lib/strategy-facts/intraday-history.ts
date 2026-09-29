import { z } from "zod";
import { symbolSchema } from "../domain";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "日期无效");
export const intradayHistorySchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    symbol: symbolSchema.optional(),
    slot: z.enum(["noon", "late"]).optional(),
    sessionId: z.string().max(200).optional(),
    signalsOnly: z.boolean().default(false),
    state: z.enum(["pending", "retry", "settled"]).optional(),
    cursor: z
      .object({
        at: z.number().finite(),
        id: z.string().max(200),
        filter: z.string().length(64),
      })
      .optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "开始日期不能晚于结束日期",
    path: ["to"],
  });
export type IntradayHistoryInput = z.input<typeof intradayHistorySchema>;

export const intradayRunsSchema = z
  .object({
    from: day.optional(),
    to: day.optional(),
    slot: z.enum(["noon", "late"]).optional(),
    status: z
      .enum(["running", "complete", "partial", "failed", "missed"])
      .optional(),
    cursor: z
      .object({
        at: z.number().finite(),
        id: z.string().max(200),
        filter: z.string().length(64),
      })
      .optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: "开始日期不能晚于结束日期",
    path: ["to"],
  });
export type IntradayRunsInput = z.input<typeof intradayRunsSchema>;
