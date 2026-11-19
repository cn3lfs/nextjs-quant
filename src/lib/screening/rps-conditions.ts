import { rpsPeriods } from "quant-rps";
import { z } from "zod";
import { rpsPeriodLabel } from "./rps";

/**
 * One AND condition over a security's or group's RPS for `period`. Shared by
 * stock, industry and concept rankings so all three express the same filter.
 */
export const rpsConditionSchema = z.object({
  period: z
    .number()
    .refine(
      (n) => (rpsPeriods as readonly number[]).includes(n),
      "不支持的RPS周期",
    ),
  side: z.enum(["gte", "lte"]),
  value: z.number().int().min(0).max(100),
});
export type RpsCondition = z.infer<typeof rpsConditionSchema>;

/** Zero conditions keep the unfiltered ranking; at most three combine with AND. */
export const rpsConditionsSchema = z
  .array(rpsConditionSchema)
  .max(3)
  .default([])
  .refine(
    (conditions) =>
      new Set(conditions.map((condition) => condition.period)).size ===
      conditions.length,
    "RPS条件周期不能重复",
  );

/** The applied-condition summary; never built from unapplied draft text. */
export function rpsConditionsLabel(conditions: readonly RpsCondition[]) {
  return conditions.length
    ? conditions
        .map(
          (condition) =>
            `${rpsPeriodLabel(condition.period)} ${
              condition.side === "gte" ? "≥" : "≤"
            } ${condition.value}`,
        )
        .join(" 且 ")
    : "无 RPS 条件";
}
