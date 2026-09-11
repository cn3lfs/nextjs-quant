import { z } from "zod";
export const clsBatchPhaseSchema = z.enum(["morning", "noon", "evening"]);
export const clsBatchReceiptSchema = z
  .object({
    version: z.literal("cls-batch-1"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    phase: clsBatchPhaseSchema,
    startedAt: z.number().finite().positive(),
    completedAt: z.number().finite().positive(),
    windowFrom: z.number().finite(),
    windowTo: z.number().finite(),
    newsIds: z.array(z.string().min(1)).max(10000),
    reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((value, ctx) => {
    if (
      value.completedAt < value.startedAt ||
      value.windowTo > value.startedAt ||
      value.windowFrom > value.windowTo ||
      new Set(value.newsIds).size !== value.newsIds.length
    )
      ctx.addIssue({ code: "custom", message: "新闻批次时间或证据ID无效" });
  });
export type ClsBatchReceipt = z.infer<typeof clsBatchReceiptSchema>;
