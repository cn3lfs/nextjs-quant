import { z } from "zod";
import { symbolSchema } from "~/lib/domain";

export const archiveKinds = [
  "report",
  "chan-report",
  "canslim-report",
  "wyckoff-report",
] as const;
export const archiveKindLabels: Record<(typeof archiveKinds)[number], string> =
  {
    report: "通用研究",
    "chan-report": "缠论",
    "canslim-report": "CAN SLIM",
    "wyckoff-report": "威科夫",
  };
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const stamp = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(stamp) &&
      new Date(stamp).toISOString().slice(0, 10) === value
    );
  }, "日期无效");
export const archiveCursorSchema = z.object({
  createdAt: z.number().finite().min(-1),
  kind: z.enum(archiveKinds),
  id: z.string().min(1).max(200),
  filter: z.string().length(64),
});
export const archiveHistoryInput = z
  .object({
    kinds: z
      .array(z.enum(archiveKinds))
      .min(1, "至少选择一种报告类型")
      .max(4)
      .optional(),
    symbol: symbolSchema.optional(),
    keyword: z.string().trim().max(100).optional(),
    from: day.optional(),
    to: day.optional(),
    cursor: archiveCursorSchema.optional(),
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: "开始日期不能晚于结束日期",
    path: ["to"],
  });
export type ArchiveCursor = z.infer<typeof archiveCursorSchema>;
export type ArchiveFilter = Omit<z.infer<typeof archiveHistoryInput>, "cursor">;
