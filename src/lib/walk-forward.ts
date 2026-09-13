import { z } from "zod";
import type { Backtest, Strategy } from "./domain";
import type { MultipleTesting } from "./multiple-testing";
export const walkForwardSchema = z.object({
  trainBars: z.number().int().min(60).max(2500).default(252),
  testBars: z.number().int().min(20).max(500).default(63),
  yearlyDays: z.number().finite().positive().optional(),
});
export type WalkForwardOptions = z.infer<typeof walkForwardSchema>;
export type WalkForwardResult = {
  corporateActions?: import("~/server/backtest-actions").BacktestActions;
  id?: string;
  createdAt?: number;
  version: "walk-forward-1";
  symbol: string;
  snapshotId: string;
  sourceHash: string;
  initial: number;
  baseStrategy: Strategy;
  dataRange?: {
    scope: "full" | "window";
    selectedSnapshotId: string;
    start: string;
    end: string;
    bars: number;
  };
  options: WalkForwardOptions;
  candidates: Strategy[];
  warmupBars: number;
  unusedTailBars: number;
  /** 旧档案没有此字段，读取时不补算或伪造。 */
  multipleTesting?: MultipleTesting & {
    overfit?: import("./backtest-overfit").BacktestOverfit;
  };
  folds: {
    trainStart: string;
    trainEnd: string;
    testStart: string;
    testEnd: string;
    trainHash: string;
    testHash: string;
    selected: Strategy;
    training: {
      strategy: Strategy;
      totalReturn: number;
      maxDrawdown: number;
      trades: number;
    }[];
    test: Backtest;
    benchmarkReturn: number;
  }[];
  summary: {
    folds: number;
    positiveFolds: number;
    averageReturn: number;
    medianReturn: number;
    worstReturn: number;
    worstDrawdown: number;
    averageBenchmarkReturn: number;
  };
  assumptions: string[];
};

export type WalkForwardPage = Omit<WalkForwardResult, "multipleTesting"> & {
  multipleTesting?: MultipleTesting & {
    overfit?: import("./backtest-overfit").BacktestOverfitSummary;
  };
};

/** 完整档案保留 λ；普通查询不携带分布，下载时单独取完整档案。 */
export function walkForwardPage(result: WalkForwardResult): WalkForwardPage {
  const overfit = result.multipleTesting?.overfit;
  if (!overfit) return result;
  const { lambdas: _lambdas, ...summary } = overfit;
  return {
    ...result,
    multipleTesting: { ...result.multipleTesting!, overfit: summary },
  };
}
