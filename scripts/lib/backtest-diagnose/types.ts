import type { PortfolioRequest } from "quant-backtest";
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
