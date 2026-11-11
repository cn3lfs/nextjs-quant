import { z } from "zod";
import { symbolSchema } from "./security.js";
import { researchDateSchema } from "./date.js";
import type { RiskPresetId } from "../risk/research-risk-presets.js";
import type { SwingDisciplineId } from "../swing/research-swing-discipline.js";
export const initialStopPolicySchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("sepa-pivot-min") }).strict(),
    z.object({ kind: z.literal("sepa-pivot-max") }).strict(),
    z.object({ kind: z.literal("canslim-pivot-max") }).strict(),
    z
      .object({
        kind: z.literal("breakout-candle"),
        buffer: z.number().finite().min(0).max(0.1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("platform-upper"),
        buffer: z.number().finite().min(0).max(0.1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("structure-auto"),
        atrPeriod: z.number().int().min(2).max(120).optional(),
        atrMultiple: z.number().finite().min(0).max(10),
        percentBuffer: z.number().finite().min(0).max(0.1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("nearest-stop"),
        fraction: z.number().finite().min(0.001).max(0.5),
        period: z.number().int().min(2).max(120),
        multiple: z.number().finite().min(0.1).max(10),
        structureBuffer: z.number().finite().min(0).max(10),
      })
      .strict(),
    z
      .object({
        kind: z.literal("max-distance"),
        fraction: z.number().finite().min(0.001).max(0.5),
        period: z.number().int().min(2).max(120),
        multiple: z.number().finite().min(0.1).max(10),
        structureBuffer: z.number().finite().min(0).max(10),
      })
      .strict(),
    z
      .object({
        kind: z.literal("structure-atr"),
        maxDistanceAtr: z.literal(2).optional(),
        period: z.number().int().min(2).max(120),
        multiple: z.number().finite().min(0.1).max(10),
      })
      .strict(),
    z
      .object({
        kind: z.literal("percent"),
        fraction: z.number().finite().min(0.001).max(0.5),
      })
      .strict(),
    z
      .object({
        kind: z.literal("atr"),
        period: z.number().int().min(2).max(120),
        multiple: z.number().finite().min(0.1).max(10),
      })
      .strict(),
    z
      .object({
        kind: z.literal("structure"),
        buffer: z.number().finite().min(0).max(0.1),
      })
      .strict(),
  ])
  .default({ kind: "percent", fraction: 0.05 });
export const stopOverridePolicySchema = z
  .object({
    symbol: symbolSchema,
    observedDate: researchDateSchema,
    price: z.number().finite().positive(),
    provenance: z.literal("manual-scenario").default("manual-scenario"),
  })
  .strict();
export type InitialStopPolicy = z.infer<typeof initialStopPolicySchema>;
export type InitialStopManagementPolicy = {
  stop: InitialStopPolicy;
  riskPreset?: RiskPresetId;
  swingDiscipline?: SwingDisciplineId;
  stopOverride?: z.infer<typeof stopOverridePolicySchema>;
};
