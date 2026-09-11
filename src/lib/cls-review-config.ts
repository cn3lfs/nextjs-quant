import { z } from "zod";
export const clsReviewConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    directory: z.string().trim().max(2048).default(""),
  })
  .superRefine((value, context) => {
    if (value.enabled && !value.directory)
      context.addIssue({ code: "custom", message: "请配置报告目录" });
  });
