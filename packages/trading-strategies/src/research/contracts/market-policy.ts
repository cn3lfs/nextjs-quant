import { z } from "zod";

export const marketChopPolicySchema = z
  .object({
    window: z.number().int().min(3).max(60),
    minCrosses: z.number().int().min(2).max(59),
    nearBand: z.number().finite().min(0.001).max(0.1),
  })
  .strict()
  .refine((v) => v.minCrosses < v.window, "穿越次数必须小于观察交易日数");
export const marketRegimePolicySchema = z
  .object({
    kind: z.literal("ma20"),
    neutralBand: z.number().finite().min(0).max(0.05),
    weakWeight: z.union([z.literal(0), z.literal(0.3)]),
  })
  .strict();
export type MarketChopPolicy = z.infer<typeof marketChopPolicySchema>;
export type MarketRegimePolicy = z.infer<typeof marketRegimePolicySchema>;
