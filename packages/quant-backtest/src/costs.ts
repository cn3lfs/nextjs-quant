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
