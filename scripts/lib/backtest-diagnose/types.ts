import type { PortfolioRequest } from "quant-backtest";
import type { NativeStudyIdentity } from "trading-strategies";
import type {
  FrozenLabBacktest,
  replayLabBacktest,
} from "../../../src/server/research/lab-backtest";

export type DiagnoseMode = "per-symbol" | "portfolio";
export type DiagnoseStatus = "ok" | "blocked" | "failed";
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

export type DiagnoseCounts = {
  bars: number;
  warmup: number;
  signals: number;
  orders: number;
  fills: number;
  rejections: number;
  closedTrades: number;
  /** Fills whose quantity was reduced by the capacity participation cap. */
  capacityClippedFills?: number;
};

export type DiagnosticCheck = {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
  evidence?: unknown;
};

export type DiagnosticReport = {
  status: DiagnoseStatus;
  layer?: DiagnoseLayer;
  counts: DiagnoseCounts;
  checks: DiagnosticCheck[];
  findings: string[];
};

export type RejectionReason = { reason: string; count: number };

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

export type DiagnoseCell = {
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
  nativeChan?: NativeChanDisclosure[];
  canslimPit?: CanslimPitDisclosure[];
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
