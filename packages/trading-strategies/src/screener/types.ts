import type { Bar } from "trading-strategy-core/bars";
import type { PatternBreakoutMatch } from "../pattern-breakout.js";

export const theoryScreenerFamilyIds = [
  "trend-breakout",
  "growth-oneil",
  "wyckoff-volume",
  "astock-dragon",
  "wave-harmonic-smc",
  "momentum-reversion",
  "value-multifactor",
] as const;
export type TheoryScreenerFamilyId = (typeof theoryScreenerFamilyIds)[number];
export type TheoryGeometryLine =
  PatternBreakoutMatch["geometry"]["lines"][number];
export type TheoryGeometryPoint = TheoryGeometryLine["points"][number];
export type TheoryScreenRpsPoint = {
  rps10?: number | null;
  rps20?: number | null;
  rps50?: number | null;
  rps120?: number | null;
  rps250?: number | null;
};
export type TheoryScreenFinancialSnapshot = {
  availableAt?: string | null;
  roe?: number | null;
  roic?: number | null;
  earningsYield?: number | null;
  pe?: number | null;
  pb?: number | null;
  grossMargin?: number | null;
  profitGrowthYoY?: number | null;
  revenueGrowthYoY?: number | null;
  debtToAsset?: number | null;
  currentRatio?: number | null;
  operatingCashFlowPerShare?: number | null;
  eps?: number | null;
  fScore?: number | null;
  fScoreEvaluated?: number | null;
  ncavPerShare?: number | null;
};
export type TheoryScreenContext = {
  bars: readonly Bar[];
  symbol?: string;
  benchmarkBars?: readonly Bar[];
  rpsAt?: (index: number) => TheoryScreenRpsPoint | null;
  financialsAt?: (index: number) => TheoryScreenFinancialSnapshot | null;
  financials?: TheoryScreenFinancialSnapshot | null;
};
export type TheoryScreenMatch = {
  family: TheoryScreenerFamilyId;
  methodId: string;
  theoryId: string;
  label: string;
  direction: "long" | "short";
  index: number;
  date: string;
  close: number;
  pivotPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  rewardMultiple: number | null;
  volumeRatio: number | null;
  score: number;
  summary: string;
  geometry: { lines: TheoryGeometryLine[] };
};
export type TheoryScreenerFilter = {
  families?: readonly TheoryScreenerFamilyId[];
  methodIds?: readonly string[];
  direction?: "long" | "short" | "both";
  minScore?: number;
  minVolumeRatio?: number;
  minRewardMultiple?: number;
};
export type TheoryScreenerMethodSpec = {
  id: string;
  theoryId: string;
  family: TheoryScreenerFamilyId;
  label: string;
  direction: "long" | "short" | "both";
  warmupBars: number;
  description: string;
};
export type PreparedTheoryFamilyScreener = {
  specs: readonly TheoryScreenerMethodSpec[];
  at: (index: number) => TheoryScreenMatch[];
};
export type TheoryFamilyScreenerFactory = (
  context: TheoryScreenContext,
) => PreparedTheoryFamilyScreener;
