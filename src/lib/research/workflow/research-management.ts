import {
  initialStopPolicySchema,
  stopOverridePolicySchema,
} from "trading-strategies/research/contracts/initial-stop";
import {
  marketChopPolicySchema,
  marketRegimePolicySchema,
} from "trading-strategies/research/contracts/market-policy";
import {
  isIntradayExecution,
  intradayExecutionInputsSchema,
} from "trading-strategies/research/technical/research-intraday-execution";
import {
  isMarketAdmission,
  marketAdmissionInputsSchema,
} from "trading-strategies/research/risk/research-market-admission";
import {
  openingPlansSchema,
  isOpening,
} from "trading-strategies/research/technical/research-opening";
import {
  contextRiskIds,
  contextRiskTemplate,
  contextRiskInputsSchema,
} from "trading-strategies/research/risk/research-context-risk";
import {
  isExternalVolatility,
  volatilityInputsSchema,
} from "trading-strategies/research/factors/research-volatility-input";
import {
  riskPresetIds,
  riskPresetTemplate,
} from "trading-strategies/research/risk/research-risk-presets";
import {
  volatilityStopIds,
  volatilityStopTemplate,
} from "trading-strategies/research/risk/research-volatility-stops";
import {
  swingDisciplineIds,
  swingDisciplineTemplate,
} from "trading-strategies/research/swing/research-swing-discipline";
import {
  growthDailyIds,
  growthDailyTemplate,
} from "trading-strategies/research/factors/research-growth-daily";
import {
  growthIntradayIds,
  growthIntradayTemplate,
} from "trading-strategies/research/factors/research-growth-intraday";
import { researchKellySchema } from "trading-strategies/research/risk/research-kelly";
import { z } from "zod";
import { researchProgressExitSchema } from "trading-strategies/research/technical/research-progress-exit";
import {
  researchExitPresetIds,
  matchesResearchExitPreset,
} from "../specs/research-exit-presets";

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
    contextRisk: z.enum(contextRiskIds).optional(),
    contextRiskInputs: contextRiskInputsSchema.optional(),
    volatilityStop: z.enum(volatilityStopIds).optional(),
    volatilityInputs: volatilityInputsSchema.optional(),
    riskPreset: z.enum(riskPresetIds).optional(),
    swingDiscipline: z.enum(swingDisciplineIds).optional(),
    growthIntraday: z.enum(growthIntradayIds).optional(),
    openingPlans: openingPlansSchema.optional(),
    marketAdmissionInputs: marketAdmissionInputsSchema.optional(),
    intradayExecutionInputs: intradayExecutionInputsSchema.optional(),
    growthDaily: z.enum(growthDailyIds).optional(),
    sepaElite: z.literal(true).optional(),
    progressExit: researchProgressExitSchema.optional(),
    kelly: researchKellySchema.optional(),
    exitPreset: z.enum(researchExitPresetIds).optional(),
    stopOverride: stopOverridePolicySchema.optional(),
    liquidityCap: z.literal(true).optional(),
    marketChop: marketChopPolicySchema.optional(),
    lossPauseDays: z.union([z.literal(1), z.literal(2)]).optional(),
    maxInitialStopDistance: z.number().finite().min(0.001).max(0.5).optional(),
    maxTotalWeight: z.number().finite().min(0.01).max(1).optional(),
    marketRegime: marketRegimePolicySchema.optional(),
    stop: initialStopPolicySchema,
    confirmations: z.union([z.literal(1), z.literal(2)]).default(1),
    // Explicit stress scenario, not an estimated future worst close.
    stressBuffer: z.number().finite().min(0).max(0.5).default(0),
    trail: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("fixed") }).strict(),
        z
          .object({
            kind: z.literal("volatility"),
            profile: z.enum(volatilityStopIds),
          })
          .strict(),
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
    if (
      value.contextRiskInputs &&
      !value.contextRisk &&
      value.growthIntraday !== "RK-C-swing-system"
    )
      context.addIssue({ code: "custom", message: "人工事件输入需具名预设" });
    if (value.contextRisk) {
      const template = contextRiskTemplate(value.contextRisk);
      if (
        Object.keys(value).some(
          (k) => k !== "contextRiskInputs" && !(k in template),
        ) ||
        Object.entries(template).some(
          ([k, v]) =>
            JSON.stringify(value[k as keyof typeof value]) !==
            JSON.stringify(v),
        )
      )
        context.addIssue({ code: "custom", message: "人工事件具名参数不匹配" });
    }
    if (value.riskPreset) {
      const template = riskPresetTemplate(value.riskPreset);
      if (
        Object.keys(value).some((k) => !(k in template)) ||
        Object.entries(template).some(
          ([k, v]) =>
            JSON.stringify(value[k as keyof typeof value]) !==
            JSON.stringify(v),
        )
      )
        context.addIssue({
          code: "custom",
          message: "规模演化具名参数不匹配，请重新应用模板",
        });
    }
    if (
      value.volatilityInputs &&
      (!value.volatilityStop || !isExternalVolatility(value.volatilityStop))
    )
      context.addIssue({
        code: "custom",
        message: "外部波动输入只属于Kase/Beta具名版本",
      });
    if (value.volatilityStop) {
      const template = volatilityStopTemplate(value.volatilityStop);
      if (
        Object.keys(value).some(
          (k) => k !== "volatilityInputs" && !(k in template),
        ) ||
        Object.entries(template).some(
          ([k, v]) =>
            JSON.stringify(value[k as keyof typeof value]) !==
            JSON.stringify(v),
        )
      )
        context.addIssue({
          code: "custom",
          message: "波动止损具名参数不匹配，请重新应用模板",
        });
    }
    if (value.swingDiscipline) {
      const template = swingDisciplineTemplate(value.swingDiscipline);
      if (
        Object.keys(value).some((k) => !(k in template)) ||
        Object.entries(template).some(
          ([k, v]) =>
            JSON.stringify(value[k as keyof typeof value]) !==
            JSON.stringify(v),
        )
      )
        context.addIssue({
          code: "custom",
          message: "波段具名管理参数不匹配，请重新应用模板",
        });
    }
    if (value.growthDaily) {
      const template = growthDailyTemplate(value.growthDaily);
      if (
        Object.keys(value).some((k) => !(k in template)) ||
        Object.entries(template).some(
          ([k, v]) =>
            JSON.stringify(value[k as keyof typeof value]) !==
            JSON.stringify(v),
        )
      )
        context.addIssue({
          code: "custom",
          message: "日线具名版本参数不匹配，请重新应用模板",
        });
    }
    if (value.growthIntraday === "RK-C-swing-system") {
      const template = growthIntradayTemplate(value.growthIntraday);
      if (
        Object.keys(value).some(
          (k) => k !== "contextRiskInputs" && !(k in template),
        ) ||
        Object.entries(template).some(
          ([k, v]) =>
            JSON.stringify(value[k as keyof typeof value]) !==
            JSON.stringify(v),
        )
      )
        context.addIssue({ code: "custom", message: "波段完整组合参数不匹配" });
    } else if (value.growthIntraday) {
      const template = growthIntradayTemplate(value.growthIntraday);
      if (
        Object.keys(value).some(
          (key) =>
            !(key in template) &&
            !(
              key === "intradayExecutionInputs" &&
              isIntradayExecution(value.growthIntraday!)
            ) &&
            !(key === "openingPlans" && isOpening(value.growthIntraday!)) &&
            !(
              key === "marketAdmissionInputs" &&
              isMarketAdmission(value.growthIntraday!)
            ),
        ) ||
        value.stop.kind !== "percent" ||
        value.stop.fraction !==
          (value.growthIntraday === "SW02-last30" ||
          isMarketAdmission(value.growthIntraday) ||
          value.growthIntraday.startsWith("RK-")
            ? 0.05
            : value.growthIntraday.startsWith("SE-")
              ? 0.1
              : 0.08) ||
        value.confirmations !== 1 ||
        value.trail.kind !== "fixed" ||
        value.stressBuffer !== 0 ||
        value.timeExit !== null
      )
        context.addIssue({
          code: "custom",
          message: "盘中具名版本使用固定管理参数，不接受其他风控叠加",
        });
    }
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
