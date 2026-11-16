import { z } from "zod";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { validationDefaults } from "quant-backtest";
import type { ValidationScore } from "quant-backtest";

export const validationInputSchema = z
  .object({
    market: z.enum(["cn-equity", "crypto"]),
    start: researchDateSchema,
    end: researchDateSchema,
    sampleSize: z.number().int().min(2).max(40).default(12),
    symbols: z.array(z.string().min(1)).min(2).max(40).optional(),
    cryptoSource: z
      .enum(["binance", "okx", "gate", "bybit"])
      .default("binance"),
    initial: z.number().finite().positive().max(1e9).default(1000000),
    policy: z
      .object({
        method: z.enum(["legacy", "lifecycle-2"]).optional(),
        purpose: z.enum(["preregistered", "post-hoc"]).optional(),
        clusterCorrelation: z.number().positive().max(1).optional(),
        maximumPbo: z.number().min(0).max(1).optional(),
        returnCriterion: z
          .enum(["risk-adjusted", "raw-excess"])
          .default(validationDefaults.returnCriterion),
        holdoutStart: researchDateSchema.optional(),
        minimumWindows: z
          .number()
          .int()
          .min(3)
          .default(validationDefaults.minimumWindows),
        minimumTrades: z
          .number()
          .int()
          .positive()
          .default(validationDefaults.minimumTrades),
        maximumDrawdown: z
          .number()
          .positive()
          .max(1)
          .default(validationDefaults.maximumDrawdown),
        minimumPositiveWindows: z
          .number()
          .gt(0.5)
          .max(1)
          .default(validationDefaults.minimumPositiveWindows),
        minimumStableNeighbors: z
          .number()
          .positive()
          .max(1)
          .default(validationDefaults.minimumStableNeighbors),
        minimumDsr: z.number().min(0.5).max(1).default(0.95),
        minimumMarketCycles: z.number().int().positive().default(3),
        trainBars: z.number().int().min(20).optional(),
        testBars: z.number().int().min(5).optional(),
      })
      .strict()
      .default({}),
  })
  .strict()
  .refine((v) => v.start < v.end, "研究起止日期倒序");
export type ValidationInput = z.infer<typeof validationInputSchema>;
export const scoreboardQuerySchema = z
  .object({
    market: z.enum(["cn-equity", "crypto"]).default("cn-equity"),
    page: z.number().int().nonnegative().default(0),
    sort: z.enum(["id", "excess", "drawdown"]).default("id"),
    descending: z.boolean().default(false),
  })
  .strict();
export type ScoreboardRow = {
  /** Full source-gap details live once in the enclosing report/scoreboard registry. */
  missingEvidenceRefs?: string[];
  evidence?: { inputHash: string; resultHash: string; buildHash: string };
  evidenceScope?: "candidate";
  strategyVersion?: number;
  method?: "lifecycle-2";
  purpose?: "preregistered" | "post-hoc";
  methodLabel?: string;
  riskAdjusted?: ValidationScore["riskAdjusted"];
  biasTags?: { code: string; severity: "high" | "medium"; detail: string }[];
  id: string;
  level: "strategy" | "sleeve" | "market";
  market: "cn-equity" | "crypto";
  sleeve: string;
  rule: string;
  status: "research" | "live-candidate" | "shadow-candidate";
  worstDrawdown?: number | null;
  dsr?: { value: number | null; reason: string | null };
  globalDsr?: { value: number | null; reason: string | null };
  trainingNeighbors?: { id: string; excess: number | null }[];
  shadow?: {
    active: boolean;
    startedAt: number;
    signals: number;
    days: number;
    paused: boolean;
    assessment: {
      at: number;
      eligible: boolean;
      reasons: string[];
      recommendation: string;
    } | null;
  };
  return: number | null;
  excess: number | null;
  drawdown: number | null;
  trades: number;
  oosWindows: number;
  positiveWindows: number;
  bias: {
    universe: string;
    adjustment: string;
    financial: string;
    execution: string;
  };
  reasons: string[];
};
