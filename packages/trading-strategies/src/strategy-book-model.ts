import { z } from "zod";
import {
  dowDualIndexDefaults,
  oneilMarketDefaults,
} from "./theory-regime-gates.js";

const fraction = z.number().finite().positive().max(1);
export const strategyRankSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rps-composite"),
      periods: z
        .array(z.number().int().positive())
        .min(1)
        .max(10)
        .default([20, 50, 120]),
    })
    .strict(),
  z
    .object({ kind: z.literal("classic"), model: z.literal("classic-five") })
    .strict(),
]);
export const strategyRegimeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("trend-breadth"),
      benchmark: z.string().min(1),
      period: z.number().int().min(2).max(500).default(20),
      minimumBreadth: z.number().finite().min(0).max(1).default(0.5),
      minimumCoverage: fraction.default(0.6),
    })
    .strict(),
  z
    .object({
      kind: z.literal("oneil-market-direction"),
      benchmark: z.string().min(1),
      distributionWindow: z
        .number()
        .int()
        .positive()
        .default(oneilMarketDefaults.distributionWindow),
      pressureThreshold: z
        .number()
        .int()
        .positive()
        .default(oneilMarketDefaults.pressureThreshold),
      correctionThreshold: z
        .number()
        .int()
        .positive()
        .default(oneilMarketDefaults.correctionThreshold),
      followThroughGain: z
        .number()
        .finite()
        .positive()
        .default(oneilMarketDefaults.followThroughGain),
      pressureScale: z
        .number()
        .min(0)
        .max(1)
        .default(oneilMarketDefaults.pressureScale),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dow-dual-index"),
      benchmark: z.string().min(1),
      secondaryBenchmark: z.string().min(1),
      swingBars: z
        .number()
        .int()
        .positive()
        .default(dowDualIndexDefaults.swingBars),
      waitScale: z
        .number()
        .min(0)
        .max(1)
        .default(dowDualIndexDefaults.waitScale),
    })
    .strict(),
]);
export const strategyOverlaySchema = z
  .object({
    volatilityTarget: fraction.optional(),
    lookback: z.literal(60).default(60),
    drawdownBrake: z
      .object({
        reduceAt: fraction.default(0.1),
        pauseAt: fraction.default(0.15),
        recoverAt: z.number().finite().min(0).max(1).default(0.05),
        pauseBars: z.number().int().positive().default(5),
      })
      .strict()
      .default({}),
    industryWeight: fraction.optional(),
    industryBasis: z
      .enum(["point-in-time", "current-labelled"])
      .default("point-in-time"),
    symbolWeight: fraction.optional(),
    heat: fraction.optional(),
    correlationGroupRisk: fraction.optional(),
    correlationThreshold: z.number().finite().min(-1).max(1).default(0.8),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!(
      v.drawdownBrake.recoverAt < v.drawdownBrake.reduceAt &&
      v.drawdownBrake.reduceAt < v.drawdownBrake.pauseAt
    ))
      ctx.addIssue({
        code: "custom",
        message:
          "Drawdown brake thresholds must increase: recover < reduce < pause",
      });
  });
export const strategyRebalanceSchema = z
  .object({
    kind: z.literal("ranked-weekly"),
    top: z.number().int().positive().max(100),
    retentionMultiple: z.number().finite().min(1).max(3).default(1.5),
    weighting: z
      .enum(["inverse-volatility", "equal"])
      .default("inverse-volatility"),
  })
  .strict();
export type StrategyRank = z.infer<typeof strategyRankSchema>;
export type StrategyRegime = z.infer<typeof strategyRegimeSchema>;
export type StrategyOverlay = z.infer<typeof strategyOverlaySchema>;
