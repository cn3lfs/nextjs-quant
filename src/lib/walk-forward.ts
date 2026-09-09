import { z } from "zod";
import type { Backtest, Strategy } from "./domain";
export const walkForwardSchema = z.object({
  trainBars: z.number().int().min(60).max(2500).default(252),
  testBars: z.number().int().min(20).max(500).default(63),
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
