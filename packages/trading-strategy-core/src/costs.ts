import { z } from "zod";
// Fixed experiment parameters, not asserted historical fees.
export const executionCostsSchema = z.object({
  version: z.literal("cost-experiment-1").default("cost-experiment-1"),
  commissionBps: z.number().finite().min(0).max(1000).default(3),
  minimumCommission: z.number().finite().min(0).max(10000).default(5),
  sellTaxBps: z.number().finite().min(0).max(1000).default(5),
  slippageBps: z.number().finite().min(0).max(1000).default(5),
});
export type ExecutionCosts = z.infer<typeof executionCostsSchema>;
export const defaultExecutionCosts = executionCostsSchema.parse({});

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
