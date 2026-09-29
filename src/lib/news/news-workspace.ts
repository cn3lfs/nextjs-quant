import { z } from "zod";

export const newsPageCursorSchema = z.object({
  time: z.number().int().nonnegative(),
  id: z.number().int().positive(),
  filter: z.string().regex(/^[a-f0-9]{64}$/),
});
export const newsWorkspaceSchema = z.object({
  cutoff: z
    .number()
    .int()
    .nonnegative()
    .refine((value) => value <= Date.now(), "截止时间不能晚于当前时间"),
  query: z.string().trim().max(100).default(""),
  historical: z.boolean().default(true),
  cursor: newsPageCursorSchema.optional(),
});
export type NewsWorkspaceInput = z.input<typeof newsWorkspaceSchema>;
export const newsPageSelectionSchema = z.object({
  source: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  cursor: newsPageCursorSchema.optional(),
});
export const newsArchiveIdSchema = z
  .string()
  .regex(/^news-analysis-[a-f0-9]{64}$/);
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
export const newsArchiveQuerySchema = z
  .object({
    from: date.optional(),
    to: date.optional(),
    query: z.string().trim().max(100).default(""),
    status: z.enum(["complete", "partial"]).optional(),
    cursor: z
      .object({
        at: z.number().int().nonnegative(),
        id: newsArchiveIdSchema,
        filter: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .optional(),
  })
  .refine(
    (value) => !value.from || !value.to || value.from <= value.to,
    "开始日期不能晚于结束日期",
  );
