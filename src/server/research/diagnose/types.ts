import type { PortfolioRequest } from "quant-backtest";
import type { NativeStudyIdentity } from "trading-strategies";
import type {
  DiagnoseArchiveSummary,
  DiagnoseCheck,
  DiagnoseCounts,
  DiagnoseScenarioCellGroup,
  DiagnoseScenarioMetrics,
} from "~/lib/research/diagnose-contract";
import type { FrozenLabBacktest, replayLabBacktest } from "../lab-backtest";

import type { NativeChanMultiDisclosure } from "./chan-native";
import type { GrowthPitDisclosure } from "./growth-pit";
import type { DiagnoseTimeHoldoutResult } from "./time-holdout";
import type { SleeveAttribution } from "./sleeve-attribution";
import type { analyzeWyckoffFunnel } from "./wyckoff-funnel";

export type { DiagnoseCounts };
export type DiagnoseMode = DiagnoseScenarioCellGroup["mode"];
export type DiagnoseStatus = DiagnoseScenarioMetrics["status"];
export type DiagnoseLayer =
  | "data"
  | "causal-price"
  | "gbbq"
  | "signal"
  | "order"
  | "fill"
  | "fee"
  | "ledger"
  | "corporate-action"
  | "internal";

export type DiagnosticCheck = DiagnoseCheck & {
  status: "pass" | "warn" | "fail";
};

export type DiagnosticReport = {
  status: DiagnoseStatus;
  layer?: DiagnoseLayer;
  counts: DiagnoseCounts;
  checks: DiagnosticCheck[];
  findings: string[];
};

export type RejectionReason =
  DiagnoseScenarioMetrics["rejectionReasons"][number];
export type UniversePoolDisclosure = NonNullable<
  DiagnoseArchiveSummary["pool"]
>;

export type NativeChanDisclosure = {
  symbol: string;
  identity: NativeStudyIdentity;
  originDate: string;
  baselineDate: string;
  firstIndex: number;
  prefixCount: number;
  captureElapsedMs: number;
  cacheLoadMs?: number | null;
  auditCount: number;
  pendingCount: number;
  signalPriceBasis: string | null;
  cached: boolean;
};

export type CanslimPitDisclosure = {
  ruleId?: string;
  symbol: string;
  strictReportCount: number;
  reportDateRange: [string, string] | null;
  qualifiedDays: number;
  missingDays: number;
  conflictDays: number;
  priceSignalCount: number;
  pitFilteredSignalCount: number;
  sourceIssuesCount: number;
  boundary: string;
};

export type StrategyDisclosures = {
  timeHoldout?: DiagnoseTimeHoldoutResult;
  sleeveAttribution?: SleeveAttribution;
  nativeChan?: (NativeChanMultiDisclosure & { strategyKey?: string })[];
  canslimPit?: (GrowthPitDisclosure & { strategyKey?: string })[];
  growthPit?: (GrowthPitDisclosure & { strategyKey?: string })[];
  wyckoffFunnel?: (ReturnType<typeof analyzeWyckoffFunnel> & {
    strategyKey?: string;
    symbol: string;
    buyOrders: number;
    buyFills: number;
  })[];
};

export type DiagnoseCell = StrategyDisclosures & {
  strategy: string;
  symbols: string[];
  mode: DiagnoseMode;
  status: DiagnoseStatus;
  layer?: DiagnoseLayer;
  error?: string;
  runPath: string;
  start?: string;
  end?: string;
  counts: DiagnoseCounts;
  overview?: unknown;
  findings: string[];
  rejectionReasons?: RejectionReason[];
  checks?: DiagnosticCheck[];
};

export type DiagnosticsInput = {
  request: PortfolioRequest;
  frozen: FrozenLabBacktest;
  replay: ReturnType<typeof replayLabBacktest>;
};

export const emptyCounts = (): DiagnoseCounts => ({
  bars: 0,
  warmup: 0,
  signals: 0,
  orders: 0,
  fills: 0,
  rejections: 0,
  closedTrades: 0,
  capacityClippedFills: 0,
});
