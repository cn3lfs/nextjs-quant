import { z } from "zod";
import { poolSelectionSchema } from "./market-pool";
import { backtestCostsSchema } from "./backtest-costs";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
    );
  });
export const researchSpecSchema = z
  .object({
    version: z.literal("strategy-research-1").default("strategy-research-1"),
    strategy: z.enum(["dual-breakout", "czsc"]),
    // Optional only for reading historical tasks; new requests require a list.
    symbols: z
      .array(z.string().regex(/^(sh(60|68)|sz(00|30))\d{4}$/))
      .min(1)
      .max(6000)
      .refine(
        (items) => new Set(items).size === items.length,
        "品种清单不能重复",
      )
      .optional(),
    czscConfig: z.union([z.literal(0), z.literal(1100)]).default(0),
    pool: poolSelectionSchema
      .nullable()
      .default({ category: "index", name: "中证A500" }),
    start: date,
    end: date,
    validationStart: date,
    holdingDays: z.number().int().min(1).max(60).default(5),
    entryMaxWait: z.number().int().min(1).max(20).default(3),
    initialCapital: z
      .number()
      .finite()
      .min(10000)
      .max(100000000)
      .default(100000),
    maxPositions: z.number().int().min(1).max(50).default(5),
    costs: backtestCostsSchema.default(() => backtestCostsSchema.parse({})),
    annualRiskFreeRate: z.number().finite().min(-0.1).max(0.2).default(0),
  })
  .superRefine((value, context) => {
    if (value.start >= value.end)
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "结束日期须晚于开始日期",
      });
    if (
      value.validationStart <= value.start ||
      value.validationStart > value.end
    )
      context.addIssue({
        code: "custom",
        path: ["validationStart"],
        message: "保留验证期须位于样本区间内部",
      });
  });
export type ResearchSpec = z.infer<typeof researchSpecSchema>;
export type ResearchEvent = {
  symbol: string;
  observedDate: string;
  endpointDate: string;
  key: string;
  strategyVersion: string;
  partition: "development" | "validation";
  evidence: string;
};

/** Closed net trade returns only. Unfilled, open and missing samples are
 * reported separately by callers, never inserted as zero-return losses.
 */
export function researchTradeStatistics(netReturns: readonly number[]) {
  if (netReturns.some((value) => !Number.isFinite(value)))
    throw new Error("收益样本含无效值");
  const wins = netReturns.filter((value) => value > 0);
  const losses = netReturns.filter((value) => value < 0);
  const mean = (values: readonly number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const averageWin = mean(wins),
    averageLoss = mean(losses);
  const sorted = [...netReturns].sort((a, b) => a - b);
  // Linear interpolation on the ordered sample (including flat returns).
  const quantile = (p: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position),
      upper = Math.ceil(position);
    return (
      sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
    );
  };
  return {
    count: netReturns.length,
    wins: wins.length,
    losses: losses.length,
    flat: netReturns.length - wins.length - losses.length,
    winRate: netReturns.length ? wins.length / netReturns.length : null,
    averageWin,
    averageLoss,
    payoffRatio:
      averageWin !== null && averageLoss !== null
        ? averageWin / Math.abs(averageLoss)
        : null,
    expectancy: mean(netReturns),
    distribution: {
      minimum: sorted[0] ?? null,
      p25: quantile(0.25),
      median: quantile(0.5),
      p75: quantile(0.75),
      maximum: sorted.at(-1) ?? null,
    },
  };
}

export function researchNavStatistics(
  initial: number,
  values: readonly number[],
  annualRiskFreeRate: number,
) {
  if (
    !Number.isFinite(initial) ||
    initial <= 0 ||
    values.some((value) => !Number.isFinite(value) || value <= 0) ||
    !Number.isFinite(annualRiskFreeRate) ||
    annualRiskFreeRate <= -1
  )
    throw new Error("净值参数无效");
  let peak = initial,
    maxDrawdown = 0;
  const returns = values.map((value, index) => {
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
    return value / (index ? values[index - 1]! : initial) - 1;
  });
  const dailyRiskFree = (1 + annualRiskFreeRate) ** (1 / 252) - 1;
  const mean = returns.length
    ? returns.reduce((sum, value) => sum + value - dailyRiskFree, 0) /
      returns.length
    : 0;
  const variance =
    returns.length > 1
      ? returns.reduce(
          (sum, value) => sum + (value - dailyRiskFree - mean) ** 2,
          0,
        ) /
        (returns.length - 1)
      : 0;
  return {
    maxDrawdown,
    totalReturn: values.length ? values.at(-1)! / initial - 1 : null,
    sharpe: variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : null,
    annualization: 252,
    observations: returns.length,
  };
}
