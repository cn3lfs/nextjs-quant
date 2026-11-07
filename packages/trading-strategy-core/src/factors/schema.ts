import { z } from "zod";
import { factorIds, resolveFactor, type FactorId } from "./catalog.js";
export const factorSpecSchema = z
  .object({
    id: z.custom<FactorId>(
      (id) => typeof id === "string" && factorIds.includes(id as FactorId),
      "未知技术因子",
    ),
    parameters: z.record(z.number().finite()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    try {
      resolveFactor(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "因子参数无效",
      });
    }
  })
  .transform((value) => resolveFactor(value).spec);

const operandSchema = z.union([
  z.object({ constant: z.number().finite() }).strict(),
  z.object({ factor: factorSpecSchema }).strict(),
]);
export const factorConditionSchema = z
  .object({
    left: factorSpecSchema,
    operator: z.enum(["gt", "gte", "lt", "lte", "cross-above", "cross-below"]),
    right: operandSchema,
  })
  .strict();
export type FactorCondition = z.infer<typeof factorConditionSchema>;
