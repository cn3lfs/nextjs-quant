import { z } from "zod";
// Fixed experiment parameters, not asserted historical fees.
export const executionCostsSchema = z.object({
  version: z.literal("cost-experiment-1").default("cost-experiment-1"),
  commissionBps: z.number().finite().min(0).max(1000).default(3),
  minimumCommission: z.number().finite().min(0).max(10000).default(5),
  sellTaxBps: z.number().finite().min(0).max(1000).default(5),
  transferBps: z.number().finite().min(0).max(1000).optional(),
  dividendTaxBps: z.number().finite().min(0).max(1000).optional(),
  sellTaxSchedule: z
    .object({
      kind: z.literal("cn-equity-historical"),
      multiplier: z.number().finite().positive().default(1),
    })
    .strict()
    .optional(),
  transferSchedule: z
    .object({
      kind: z.literal("cn-equity-transfer"),
      multiplier: z.number().finite().positive().default(1),
    })
    .strict()
    .optional(),
  slippageBps: z.number().finite().min(0).max(1000).default(5),
});
export type ExecutionCosts = z.infer<typeof executionCostsSchema>;
export const defaultExecutionCosts = executionCostsSchema.parse({});

/** Lab and research CLIs share these three explicit scenarios. `fixed` keeps
 * the legacy lab default (no historical stamp-duty switch); `base` and
 * `double-cost` use the declared historical schedule. */
export const researchCostScenarios = ["fixed", "base", "double-cost"] as const;
export type ResearchCostScenario = (typeof researchCostScenarios)[number];

/** Pure cost construction, never broker-history certification. */
export function researchExecutionCosts(
  market: "cn-equity" | "crypto",
  scenario: ResearchCostScenario,
): ExecutionCosts {
  const multiplier = scenario === "double-cost" ? 2 : 1;
  if (scenario === "fixed")
    return executionCostsSchema.parse(
      market === "crypto"
        ? {
            commissionBps: 10,
            minimumCommission: 0,
            sellTaxBps: 0,
            slippageBps: 5,
          }
        : {
            commissionBps: 3,
            minimumCommission: 5,
            sellTaxBps: 5,
            slippageBps: 5,
          },
    );
  return executionCostsSchema.parse({
    commissionBps: (market === "crypto" ? 10 : 3) * multiplier,
    minimumCommission: market === "crypto" ? 0 : 5 * multiplier,
    sellTaxBps: market === "crypto" ? 0 : 5 * multiplier,
    ...(market === "cn-equity"
      ? {
          transferBps: 0.1 * multiplier,
          sellTaxSchedule: {
            kind: "cn-equity-historical",
            multiplier,
          },
          transferSchedule: {
            kind: "cn-equity-transfer",
            multiplier,
          },
        }
      : {}),
    slippageBps: 5 * multiplier,
  });
}

function feeDay(date: string) {
  const day = date.slice(0, 10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(Date.parse(day)) ||
    new Date(day).toISOString().slice(0, 10) !== day
  )
    throw new Error("Invalid fee date");
  return day;
}
export function equityStampDutyBps(date: string) {
  const day = feeDay(date);
  return historicalFeeScenarios.find((row) => day >= row.from)!.sellTax * 10000;
}
export function equityTransferBps(date: string) {
  const day = feeDay(date);
  return (
    historicalFeeScenarios.find((row) => day >= row.from)!.transfer * 10000
  );
}
/** Only explicitly declared historical scenarios vary by date. Legacy fixed
 * costs retain both their values and object identity. */
export function executionCostsForDate(
  costs: ExecutionCosts,
  date: string,
): ExecutionCosts {
  if (!costs.sellTaxSchedule && !costs.transferSchedule) return costs;
  return {
    ...costs,
    ...(costs.sellTaxSchedule
      ? {
          sellTaxBps:
            equityStampDutyBps(date) * costs.sellTaxSchedule.multiplier,
        }
      : {}),
    ...(costs.transferSchedule
      ? {
          transferBps:
            equityTransferBps(date) * costs.transferSchedule.multiplier,
        }
      : {}),
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
