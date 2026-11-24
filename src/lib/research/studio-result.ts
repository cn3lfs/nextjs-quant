import { z } from "zod";
import { completedBar } from "trading-strategy-core/completed-bars";
import {
  etfRotationConfigSchema,
  strategyObjectSchema,
} from "trading-strategies";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { researchCostScenarios } from "trading-strategy-core/costs";
import {
  alphaBacktestInputSchema,
  alphaTargetOptionsSchema,
  targetSnapshotSchema,
} from "./alpha-experiment";
import {
  diagnoseArchiveDetailInputSchema,
  diagnoseBookInputSchema,
  diagnoseDrawdownSchema,
  diagnoseFamilyHoldoutSchema,
  diagnosePerformanceSchema,
  diagnoseResultInputSchema,
  diagnoseSleeveAttributionSchema,
  diagnoseTimeHoldoutSchema,
  diagnoseTradeExcursionSchema,
} from "./diagnose-contract";

export const studioTemplateKinds = [
  "single",
  "multi-book",
  "etf-rotation",
  "alpha-formula",
  "exit-family",
  "ma-baseline-5m",
] as const;
export type StudioTemplateKind = (typeof studioTemplateKinds)[number];
const symbol = z.string().regex(/^(sh|sz|bj)\d{6}$/);
const stockUniverse = z.union([
  z.enum(["core-12", "core-30-v1"]),
  z
    .array(symbol)
    .min(1)
    .max(12)
    .refine((rows) => new Set(rows).size === rows.length, "标的重复"),
]);
const amount = z.number().finite();
const cost = z.enum(researchCostScenarios);
const common = z
  .object({
    start: researchDateSchema,
    end: researchDateSchema,
    initial: amount.positive().max(1e9),
    costScenario: cost.default("base"),
  })
  .strict();
const riskPolicy = alphaBacktestInputSchema.shape.riskPolicy;
const holdoutStart = researchDateSchema.optional();
const single = common.extend({
  template: z.literal("single"),
  universe: stockUniverse,
  strategy: z.union([z.string().min(1), strategyObjectSchema]),
  riskPolicy,
  holdoutStart,
});
const book = common.extend({
  template: z.literal("multi-book"),
  universe: stockUniverse,
  book: diagnoseBookInputSchema,
  bookControl: z.enum(["none", "equal-month-end", "risk-parity-60"]).optional(),
  riskPolicy,
  holdoutStart,
});
const family = common.extend({
  template: z.literal("exit-family"),
  universe: stockUniverse,
  family: z.string().min(1).max(300).default("ch14-exits"),
  holdoutStart: researchDateSchema,
  costScenario: z.enum(["base", "fixed"]).default("base"),
});
const etf = common.extend({
  template: z.literal("etf-rotation"),
  universe: z.literal("etf-21").default("etf-21"),
  config: etfRotationConfigSchema,
  riskPolicy,
  executionReality: z.boolean().optional(),
});
const alpha = common.extend({
  template: z.literal("alpha-formula"),
  universe: z.literal("alpha-panel").default("alpha-panel"),
  costScenario: z.enum(["base", "double-cost"]).default("base"),
  riskPolicy,
  source: z.union([
    z.object({ snapshot: targetSnapshotSchema }).strict(),
    z
      .object({
        compositeId: z.string().min(1),
        panelId: z.string().regex(/^[a-f0-9]{64}$/),
        targetOptions: alphaTargetOptionsSchema.default({}),
      })
      .strict(),
  ]),
});
const ma = common.extend({
  template: z.literal("ma-baseline-5m"),
  universe: z.array(z.string().regex(/^(sh60|sz00)\d{4}$/)).length(1),
  initial: amount.min(1000).max(1e9),
});
export const researchStudioDraftSchema = z
  .discriminatedUnion("template", [single, book, etf, alpha, family, ma])
  .superRefine((d, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (d.start > d.end || !completedBar(d.end, "day", Date.now()))
      issue("仅可回放完整历史日期");
    if (
      d.start === d.end &&
      (d.template === "multi-book" ||
        (d.template === "single" && typeof d.strategy === "string"))
    )
      issue("诊断回放的开始日期须早于结束日期");
    if (
      "holdoutStart" in d &&
      d.holdoutStart &&
      (d.holdoutStart <= d.start || d.holdoutStart > d.end)
    )
      issue("留出切点必须在研究区间内且晚于起点");
    if (
      d.template === "alpha-formula" &&
      "snapshot" in d.source &&
      (d.start !== d.source.snapshot.start || d.end !== d.source.snapshot.end)
    )
      issue("草稿区间与冻结目标区间不一致");
  });
export const studioEtfRotationInputSchema = etf.refine(
  (d) => d.start <= d.end && completedBar(d.end, "day", Date.now()),
  "仅可回放完整历史日期",
);
export type ResearchStudioDraft = z.output<typeof researchStudioDraftSchema>;
export type ResearchStudioDraftInput = z.input<
  typeof researchStudioDraftSchema
>;
export type StudioEtfRotationInput = z.input<
  typeof studioEtfRotationInputSchema
>;

const archiveSelection = z
  .object({
    cellIndex: z.number().int().nonnegative().optional(),
    scenarioId: z.string().min(1).optional(),
  })
  .strict();
export const studioArchiveDetailInputSchema = z.union([
  archiveSelection.extend({
    archiveId: diagnoseArchiveDetailInputSchema.shape.id,
  }),
  archiveSelection.extend({ jobId: diagnoseResultInputSchema.shape.jobId }),
]);
export type StudioArchiveDetailInput = z.output<
  typeof studioArchiveDetailInputSchema
>;

const nullable = amount.nullable();
const reason = z.string().nullable();
const gridCount = z.number().int().nonnegative();
export const maxParameterGridCells = 36;
export const parameterGridWarning =
  "参数高原仅作稳健性诊断，严禁据此挑选最优参数外推实盘";
const axisSchema = z.object({
  key: z.string().min(1),
  values: z.array(amount).min(1).max(maxParameterGridCells),
});
export const studioParameterGridResultSchema = z.object({
  status: z.enum(["reviewed", "insufficient"]),
  warning: z.literal(parameterGridWarning),
  xAxis: axisSchema,
  yAxis: axisSchema,
  holdoutStart: researchDateSchema,
  windows: z.array(
    z.object({
      trainStart: researchDateSchema,
      trainEnd: researchDateSchema,
      start: researchDateSchema,
      end: researchDateSchema,
    }),
  ),
  devOosDays: gridCount,
  trailingDevelopmentDays: gridCount,
  cells: z
    .array(
      z.object({
        x: amount,
        y: amount,
        trades: gridCount.nullable(),
        totalReturn: nullable,
        maxDrawdown: nullable,
        sharpe: nullable,
        dsr: nullable,
        meetsDsrThreshold: z.boolean().nullable(),
        reason,
      }),
    )
    .max(maxParameterGridCells),
  pboMetric: z.literal("sharpe"),
  pbo: nullable,
  dsrReference: z.object({ x: amount, y: amount }),
  dsr: nullable,
  dsrThreshold: z.literal(0.95),
  effectiveTrials: gridCount.nullable(),
  distinctReturnSeries: gridCount.nullable(),
  cscvCombinations: gridCount.nullable(),
  discardedCscvDays: gridCount.nullable(),
  reason,
});
export type StudioParameterGridResult = z.output<
  typeof studioParameterGridResultSchema
>;
export const studioDrawdownSchema = diagnoseDrawdownSchema;
export const studioExcursionSchema = diagnoseTradeExcursionSchema.partial({
  strategyId: true,
  sleeve: true,
});
export const studioPerformanceSchema = diagnosePerformanceSchema;
const costRow = z.object({
  costScenario: cost,
  totalReturn: nullable,
  maxDrawdown: nullable,
  totalFees: nullable,
  fills: nullable,
  reason,
});
const distribution = z.object({
  count: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  maeMedian: nullable,
  maeP10: nullable,
  mfeMedian: nullable,
  mfeP90: nullable,
});
const reality = z.object({
  portfolioSourceHash: z.string(),
  targetStreamHash: z.string(),
  matrix: z
    .array(
      z.object({
        initial: amount,
        window: z.string(),
        totalReturn: nullable,
        maxDrawdown: nullable,
        fills: z.number().int(),
        requestedQuotes: z.number().int(),
        missingQuotes: z.number().int(),
        firstUncertainExecutionDate: reason,
        totalFees: amount,
      }),
    )
    .length(9),
});
export const studioResultSchema = z.object({
  parameterGrid: studioParameterGridResultSchema.optional(),
  version: z.literal("studio-result-v1"),
  template: z.enum(studioTemplateKinds),
  jobId: reason,
  archiveId: reason,
  strategyKey: z.string().nullable(),
  symbols: z.array(z.string()),
  costScenario: cost.nullable(),
  performance: studioPerformanceSchema.nullable(),
  equity: z
    .array(z.object({ date: researchDateSchema, value: amount }))
    .nullable(),
  totalReturn: nullable,
  maxDrawdown: nullable,
  costScenarios: z.array(costRow).length(3),
  executionReality: reality.nullable(),
  timeHoldout: diagnoseTimeHoldoutSchema.nullable(),
  sleeveAttribution: diagnoseSleeveAttributionSchema.nullable(),
  familyHoldout: diagnoseFamilyHoldoutSchema.nullable(),
  topDrawdowns: z.array(studioDrawdownSchema).max(5).nullable(),
  tradeExcursions: z.array(studioExcursionSchema).nullable(),
  excursionDistribution: distribution.nullable(),
  disclosures: z.array(z.string()),
  cases: z.array(
    z.object({
      strategyKey: z.string(),
      symbols: z.array(z.string()),
      scenarioId: z.string(),
      status: z.string(),
      totalReturn: nullable,
      maxDrawdown: nullable,
    }),
  ),
});
export type StudioResult = z.infer<typeof studioResultSchema>;
