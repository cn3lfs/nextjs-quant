import { z } from "zod";
import { strategyObjectSchema } from "trading-strategies";

export const planProtectionSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal("plan-protection-1"),
      exitSpec: strategyObjectSchema.innerType().shape.exit,
      initialStop: z.number().finite().positive(),
      target: z.number().finite().positive().nullable(),
      entryReference: z.number().finite().positive(),
      asOf: z.string(),
      matchesStrategy: z.boolean().optional(),
      overrideReason: z.string().nullable().optional(),
      initialStopEvidence: z
        .object({
          bar: z.string(),
          source: z.string(),
          level: z.number().positive().nullable(),
        })
        .optional(),
    })
    .strict(),
  z
    .object({ version: z.literal("unavailable"), reason: z.string().min(1) })
    .strict(),
]);
export type PlanProtection = z.infer<typeof planProtectionSchema>;
export const planSizingAuditSchema = z
  .object({
    source: z.string(),
    validated: z.boolean(),
    scheme: z.enum(["legacy", "equal", "volatility", "user"]),
    riskPerTrade: z.number().finite().positive(),
    maxPositions: z.number().int().positive(),
    weightCeiling: z.number().finite().min(0).max(1),
    signalDate: z.string(),
    budget: z.number().finite().nonnegative(),
    expectedQuantities: z.array(z.number().finite().nonnegative()),
    actualQuantities: z.array(z.number().finite().positive()),
    estimatedFees: z.number().finite().nonnegative(),
    overridden: z.boolean(),
    reason: z.string().nullable(),
    at: z.number().finite(),
  })
  .strict();
