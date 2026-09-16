import { researchKellySchema } from "./research-kelly";
import {
  isGrowthPivotStop,
  researchGrowthPivotStop,
} from "./research-growth-stops";
import { z } from "zod";
import { symbolSchema } from "./domain";
import { researchDateSchema } from "./research-usage";
import { researchProgressExitSchema } from "./research-progress-exit";
import {
  researchExitPresetIds,
  matchesResearchExitPreset,
} from "./research-exit-presets";

export const researchManagementVersion = "research-management-1";
export const researchScaleOutVersion = "research-scale-out-1";
export const researchProtectionVersion = "research-protection-1";
export const researchPyramidVersion = "research-pyramid-1";
export const researchPullbackVersion = "research-pullback-1";
export const researchScaleOutPreset = [
  { atR: 2, fraction: 1 / 3, raiseStopR: 0 },
  { atR: 4, fraction: 1 / 3, raiseStopR: 3 },
];
export const researchManagementSources = [
  "stop-loss/references/methods.md",
  "stop-loss/references/volatility-family.md",
  "stop-loss/references/position-sizing.md",
] as const;
export const researchManagementSchema = z
  .object({
    sepaElite: z.literal(true).optional(),
    progressExit: researchProgressExitSchema.optional(),
    kelly: researchKellySchema.optional(),
    exitPreset: z.enum(researchExitPresetIds).optional(),
    stopOverride: z
      .object({
        symbol: symbolSchema,
        observedDate: researchDateSchema,
        price: z.number().finite().positive(),
        provenance: z.literal("manual-scenario").default("manual-scenario"),
      })
      .strict()
      .optional(),
    liquidityCap: z.literal(true).optional(),
    marketChop: z
      .object({
        window: z.number().int().min(3).max(60),
        minCrosses: z.number().int().min(2).max(59),
        nearBand: z.number().finite().min(0.001).max(0.1),
      })
      .strict()
      .refine((v) => v.minCrosses < v.window, "穿越次数必须小于观察交易日数")
      .optional(),
    lossPauseDays: z.union([z.literal(1), z.literal(2)]).optional(),
    maxInitialStopDistance: z.number().finite().min(0.001).max(0.5).optional(),
    maxTotalWeight: z.number().finite().min(0.01).max(1).optional(),
    marketRegime: z
      .object({
        kind: z.literal("ma20"),
        neutralBand: z.number().finite().min(0).max(0.05),
        weakWeight: z.union([z.literal(0), z.literal(0.3)]),
      })
      .strict()
      .optional(),
    stop: z
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
      .default({ kind: "percent", fraction: 0.05 }),
    confirmations: z.union([z.literal(1), z.literal(2)]).default(1),
    // Explicit stress scenario, not an estimated future worst close.
    stressBuffer: z.number().finite().min(0).max(0.5).default(0),
    trail: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixed") }).strict(),
        z.object({ kind: z.literal("retracement") }).strict(),
        z
          .object({
            kind: z.literal("distance"),
            distance: z.number().finite().positive().max(1000000),
          })
          .strict(),
        z
          .object({
            kind: z.literal("rolling-chandelier"),
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
            kind: z.literal("chandelier"),
            period: z.number().int().min(2).max(120),
            multiple: z.number().finite().min(0.1).max(10),
          })
          .strict(),
        z
          .object({
            kind: z.literal("close-atr"),
            period: z.number().int().min(2).max(120),
            multiple: z.number().finite().min(0.1).max(10),
          })
          .strict(),
      ])
      .default({ kind: "fixed" }),
    trailAfterScaleOut: z.boolean().optional(),
    pyramid: z
      .discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("r-50-30-20"),
            maxTotalWeight: z.number().finite().min(0.01).max(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal("pullback-50-50"),
            maxTotalWeight: z.number().finite().min(0.01).max(1),
            waitBars: z.number().int().min(1).max(20),
            tolerance: z.number().finite().min(0).max(0.05),
            requireProfit: z.boolean(),
          })
          .strict(),
      ])
      .optional(),
    breakeven: z
      .object({
        atR: z.number().finite().min(0.1).max(10),
        mode: z.literal("r-only").optional(),
      })
      .strict()
      .optional(),
    timeExit: z
      .object({
        days: z.number().int().min(1).max(60),
        minR: z.number().finite().min(0).max(10),
      })
      .strict()
      .nullable()
      .default(null),
    scaleOut: z
      .array(
        z
          .object({
            atR: z.number().finite().positive().max(100),
            fraction: z.number().finite().positive().max(1),
            raiseStopR: z.number().finite().min(-1).max(100).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(8)
      .superRefine((rows, context) => {
        if (rows.reduce((sum, row) => sum + row.fraction, 0) > 1 + 1e-10)
          context.addIssue({
            code: "custom",
            message: "分批比例合计不能超过初始仓位",
          });
        if (
          rows.some(
            (row, i) =>
              (i > 0 && row.atR <= rows[i - 1]!.atR) ||
              (row.raiseStopR != null && row.raiseStopR > row.atR),
          )
        )
          context.addIssue({
            code: "custom",
            message: "止盈档位须递增，抬升止损不能高于对应触发档位",
          });
      })
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.exitPreset && !matchesResearchExitPreset(value))
      context.addIssue({
        code: "custom",
        path: ["exitPreset"],
        message: "退出预设与当前参数不一致",
      });
    if (
      value.trailAfterScaleOut &&
      (!value.scaleOut || value.trail.kind === "fixed")
    )
      context.addIssue({
        code: "custom",
        path: ["trailAfterScaleOut"],
        message: "末档后跟随需要分批档位和有效移动止损方法",
      });
  });
export type ResearchManagement = z.infer<typeof researchManagementSchema>;

export function researchStopOverride(
  management: ResearchManagement | undefined,
  evidence: { symbol?: string; observedDate?: string },
) {
  const override = management?.stopOverride;
  return override &&
    override.symbol === evidence.symbol &&
    override.observedDate === evidence.observedDate
    ? override
    : null;
}

export function researchStopComparison(
  stop: ResearchManagement["stop"],
  entry: number,
  evidence: { initialStop?: number | null; stopAtr?: number | null },
) {
  if (stop.kind !== "max-distance" && stop.kind !== "nearest-stop") return null;
  const { initialStop: structure, stopAtr: atr } = evidence;
  if (
    !Number.isFinite(entry) ||
    entry <= 0 ||
    structure == null ||
    !Number.isFinite(structure) ||
    structure <= 0 ||
    atr == null ||
    !Number.isFinite(atr) ||
    atr <= 0
  )
    return null;
  const candidates = [
    { kind: "percent" as const, price: entry * (1 - stop.fraction) },
    { kind: "atr" as const, price: entry - stop.multiple * atr },
    {
      kind: "structure" as const,
      price: structure - stop.structureBuffer * atr,
    },
  ];
  if (
    candidates.some(
      (c) => !Number.isFinite(c.price) || c.price <= 0 || c.price >= entry,
    )
  )
    return null;
  return {
    candidates,
    selected: (stop.kind === "nearest-stop" ? Math.max : Math.min)(
      ...candidates.map((c) => c.price),
    ),
  };
}

export function researchMaximumDistance(
  stop: ResearchManagement["stop"],
  entry: number,
  evidence: { initialStop?: number | null; stopAtr?: number | null },
) {
  return stop.kind === "max-distance"
    ? researchStopComparison(stop, entry, evidence)
    : null;
}

export function researchInitialStop(
  management: ResearchManagement,
  entry: number,
  evidence: {
    initialStop?: number | null;
    stopAtr?: number | null;
    symbol?: string;
    observedDate?: string;
    entryPriceRange?: { min: number; max: number };
  },
) {
  const override = researchStopOverride(management, evidence);
  if (override)
    return Number.isFinite(entry) &&
      Number.isFinite(override.price) &&
      override.price > 0 &&
      override.price < entry
      ? override.price
      : null;
  const stop = management.stop;
  if (isGrowthPivotStop(stop.kind))
    return researchGrowthPivotStop(
      stop.kind,
      entry,
      evidence.entryPriceRange?.min,
    );
  if (stop.kind === "max-distance" || stop.kind === "nearest-stop")
    return researchStopComparison(stop, entry, evidence)?.selected ?? null;
  const value =
    stop.kind === "structure-auto"
      ? evidence.initialStop != null &&
        Number.isFinite(evidence.initialStop) &&
        evidence.initialStop > 0
        ? stop.atrPeriod == null
          ? evidence.initialStop * (1 - stop.percentBuffer)
          : evidence.stopAtr != null &&
              Number.isFinite(evidence.stopAtr) &&
              evidence.stopAtr > 0
            ? evidence.initialStop - stop.atrMultiple * evidence.stopAtr
            : null
        : null
      : stop.kind === "percent"
        ? entry * (1 - stop.fraction)
        : stop.kind === "structure-atr"
          ? evidence.initialStop != null &&
            evidence.stopAtr != null &&
            Number.isFinite(evidence.stopAtr) &&
            evidence.stopAtr > 0
            ? evidence.initialStop - stop.multiple * evidence.stopAtr
            : null
          : stop.kind === "atr"
            ? evidence.stopAtr != null && evidence.stopAtr > 0
              ? entry - stop.multiple * evidence.stopAtr
              : null
            : evidence.initialStop != null && "buffer" in stop
              ? evidence.initialStop * (1 - stop.buffer)
              : null;
  return value != null && Number.isFinite(value) && value > 0 && value < entry
    ? value
    : null;
}
