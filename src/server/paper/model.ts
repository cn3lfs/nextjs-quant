import { z } from "zod";
import type { PortfolioRequest, runPortfolio } from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import type { ShadowRegistration } from "../alerts/shadow";
import type { ScoreboardRow } from "../research/validation-model";
import type { Bar } from "trading-strategy-core/bars";

export const paperSettingsSchema = z
  .object({
    grouping: z.enum(["candidate", "sleeve"]).default("candidate"),
    equityInitial: z.number().finite().positive().max(1e9).default(1000000),
    cryptoInitial: z.number().finite().positive().max(1e9).default(100000),
  })
  .strict();
export const mirrorSettingsSchema = z.discriminatedUnion("venue", [
  z.object({ venue: z.literal("off") }).strict(),
  z
    .object({
      venue: z.literal("binance"),
      network: z.enum(["demo", "testnet"]),
    })
    .strict(),
  z
    .object({ venue: z.literal("ths"), network: z.literal("simulation") })
    .strict(),
]);
export type PaperResult = ReturnType<typeof runPortfolio>;
export type FrozenCandidate = {
  strategy: StrategyObjectInput;
  row: ScoreboardRow;
  registration: Omit<ShadowRegistration, "startedAt">;
  expectation: {
    windows: {
      return: number | null;
      drawdown: number | null;
      trades: number;
    }[];
    holdout: unknown;
    biasTags?: ScoreboardRow["biasTags"];
  };
};
export type PaperAccount = {
  id: string;
  market: "cn-equity" | "crypto";
  currency: "CNY" | "USDT";
  sleeve: string;
  startedAt: number;
  initial: number;
  candidates: FrozenCandidate[];
  mirror: z.infer<typeof mirrorSettingsSchema>;
  mirrorRevision: string;
  mirrorSince?: number;
  mirrorRecovery?: Exclude<
    z.infer<typeof mirrorSettingsSchema>,
    { venue: "off" }
  >;
  revision: number;
  lastBar: string | null;
  lastRun: number | null;
  error: string | null;
  summary: PaperSummary | null;
};
export type PaperSummary = {
  return: number | null;
  drawdown: number | null;
  trades: number;
  winRate: number | null;
  benchmarkReturn: number | null;
  signals: number;
  days: number;
  assessment: { recommendation: string; reasons: string[] } | null;
};
export type PaperState = {
  request: PortfolioRequest;
  result: PaperResult;
  benchmark: Bar[];
  /** Decision evidence is captured at first observation, including catch-up. */
  decisions: {
    strategyId: string;
    symbol: string;
    date: string;
    entry: boolean | null;
    exit: boolean | null;
    stop: number | null;
    observedAt: number;
    source: string;
  }[];
};
export type PaperFactKind =
  | "order"
  | "fill"
  | "position"
  | "equity"
  | "rejection"
  | "action"
  | "advance"
  | "mirror";
export type PaperFact = { id: string; date: string; value: unknown };
