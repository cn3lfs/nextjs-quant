import { z } from "zod";
// Fixed experiment parameters, not asserted historical fees.
export const executionCostsSchema = z.object({
  version: z.literal("cost-experiment-1").default("cost-experiment-1"),
  commissionBps: z.number().finite().min(0).max(1000).default(3),
  minimumCommission: z.number().finite().min(0).max(10000).default(5),
  sellTaxBps: z.number().finite().min(0).max(1000).default(5),
  sellTaxSchedule: z
    .object({
      kind: z.literal("cn-equity-historical"),
      multiplier: z.number().finite().positive().default(1),
    })
    .strict()
    .optional(),
  slippageBps: z.number().finite().min(0).max(1000).default(5),
});
export type ExecutionCosts = z.infer<typeof executionCostsSchema>;
export const defaultExecutionCosts = executionCostsSchema.parse({});

export function equityStampDutyBps(date: string) {
  const day = date.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error("Invalid stamp-duty date");
  return historicalFeeScenarios.find((row) => day >= row.from)!.sellTax * 10000;
}
/** Only explicitly declared historical scenarios vary by date. Legacy fixed
 * costs retain both their values and object identity. */
export function executionCostsForDate(
  costs: ExecutionCosts,
  date: string,
): ExecutionCosts {
  if (!costs.sellTaxSchedule) return costs;
  return {
    ...costs,
    sellTaxBps: equityStampDutyBps(date) * costs.sellTaxSchedule.multiplier,
  };
}

const historicalFeeScenarios = [
  { from: "2023-08-28", transfer: 0.00001, sellTax: 0.0005 },
  { from: "2022-04-29", transfer: 0.00001, sellTax: 0.001 },
  { from: "", transfer: 0.00002, sellTax: 0.001 },
] as const;
/** Original allocation-study fee experiment; no broker-history certification. */
export function historicalEquityResearchFee(
  date: string,
  amount: number,
  sell: boolean,
) {
  const rule = historicalFeeScenarios.find((row) => date >= row.from)!;
  return (
    Math.max(5, amount * 0.0003) +
    amount * rule.transfer +
    (sell ? amount * rule.sellTax : 0)
  );
}
