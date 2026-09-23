import { z } from "zod";
import { symbolSchema } from "../../domain";
import { valuationInputSchema } from "./valuation";

export const valuationScenarioSchema = z
  .object({
    symbol: symbolSchema,
    title: z.string().trim().min(1).max(120),
    scenarios: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(40),
            assumptions: valuationInputSchema,
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.scenarios.map((row) => row.name)).size !==
      value.scenarios.length
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: "情景名称不能重复",
      });
    if (
      new Set(value.scenarios.map((row) => row.assumptions.method)).size !== 1
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: "DCF与郭永清法必须分别保存，不合并估值区间",
      });
  });
