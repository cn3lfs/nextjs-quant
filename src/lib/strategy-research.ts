import {
  wyckoffStructureInputsSchema,
  isWyckoffStructure,
} from "./research-wyckoff";
import {
  wyckoffHourlyInputsSchema,
  isWyckoffHourly,
} from "./research-wyckoff-hourly";
import { wyckoffInputsSchema, isWyckoffVsa } from "./research-wyckoff-vsa";
import { riskRepairSchema } from "./research-risk-repair";
import {
  riskRouteSchema,
  resolveRiskRoute,
  stopDiagnosisSchema,
  diagnosisTemplate,
} from "./research-risk-routing";
import { riskExtensionSchema } from "./research-risk-extensions";
import { contextRiskMaxPositions } from "~/lib/research-context-risk";
import { z } from "zod";
import { riskPresetParameters, riskPresetBase } from "./research-risk-presets";
import { growthIntradayBase } from "./research-growth-intraday";
import { growthDailyBase } from "./research-growth-daily";
import { poolSelectionSchema } from "./market-pool";
import { backtestCostsSchema } from "./backtest-costs";
import { maParamsSchema } from "./domain";
import { researchManagementSchema } from "./research-management";
import type { RuleStop } from "./research-volume";
import {
  researchRiskSchema,
  researchStrategySchema,
} from "./research-strategies";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const timestamp = Date.parse(value);
    return (
      Number.isFinite(timestamp) &&
      new Date(timestamp).toISOString().slice(0, 10) === value
    );
  });
export const researchSpecSchema = z
  .object({
    version: z.literal("strategy-research-1").default("strategy-research-1"),
    strategy: researchStrategySchema,
    wyckoffStructureInputs: wyckoffStructureInputsSchema.optional(),
    wyckoffHourlyInputs: wyckoffHourlyInputsSchema.optional(),
    wyckoffInputs: wyckoffInputsSchema.optional(),
    // Optional fields preserve the exact shape/fingerprint of historical specs.
    maParams: maParamsSchema.optional(),
    risk: researchRiskSchema.optional(),
    management: researchManagementSchema.optional(),
    riskExtension: riskExtensionSchema.optional(),
    riskRepair: riskRepairSchema.optional(),
    riskRoute: riskRouteSchema.optional(),
    stopDiagnosis: stopDiagnosisSchema.optional(),
    // Optional only for reading historical tasks; new requests require a list.
    symbols: z
      .array(z.string().regex(/^(sh(60|68)|sz(00|30))\d{4}$/))
      .min(1)
      .max(6000)
      .refine(
        (items) => new Set(items).size === items.length,
        "品种清单不能重复",
      )
      .optional(),
    czscConfig: z.union([z.literal(0), z.literal(1100)]).default(0),
    pool: poolSelectionSchema
      .nullable()
      .default({ category: "index", name: "中证A500" }),
    start: date,
    end: date,
    validationStart: date,
    holdingDays: z.number().int().min(1).max(60).default(5),
    entryMaxWait: z.number().int().min(1).max(20).default(3),
    initialCapital: z
      .number()
      .finite()
      .min(10000)
      .max(100000000)
      .default(100000),
    maxPositions: z.number().int().min(1).max(50).default(5),
    costs: backtestCostsSchema.default(() => backtestCostsSchema.parse({})),
    annualRiskFreeRate: z.number().finite().min(-0.1).max(0.2).default(0),
  })
  .superRefine((value, context) => {
    if (
      value.wyckoffStructureInputs &&
      !isWyckoffStructure(value.strategy) &&
      value.strategy !== "chan-consolidation-weekly-native" &&
      value.strategy !== "chan-bottom-monthly-c4"
    )
      context.addIssue({
        code: "custom",
        message: "结构输入仅用于具名威科夫结构方法",
      });
    if (
      value.wyckoffHourlyInputs &&
      !isWyckoffHourly(value.strategy) &&
      value.strategy !== "wy-week-day-hour"
    )
      context.addIssue({
        code: "custom",
        message: "小时结构证据仅用于威科夫小时策略",
      });
    if (value.wyckoffInputs && !isWyckoffVsa(value.strategy))
      context.addIssue({
        code: "custom",
        message: "VSA历史证据仅用于威科夫VSA策略",
      });
    if (
      value.riskRepair &&
      (value.riskRepair.observedDate < value.start ||
        value.riskRepair.observedDate > value.end)
    )
      context.addIssue({
        code: "custom",
        message: "修复观察日必须位于研究区间",
      });
    if (value.riskRoute) {
      const route = resolveRiskRoute(value.riskRoute);
      const { contextRiskInputs: _inputs, ...management } =
        value.management ?? {};
      if (
        value.riskRoute.knownOn > value.start ||
        value.stopDiagnosis ||
        (route.management
          ? Object.entries(route.management).some(
              ([k, v]) =>
                JSON.stringify(management[k as keyof typeof management]) !==
                JSON.stringify(v),
            ) || Object.keys(management).some((k) => !(k in route.management!))
          : !value.riskExtension ||
            value.riskExtension.kind !== "protective-put")
      )
        context.addIssue({
          code: "custom",
          message: "路由须开始前冻结且管理参数与具名分支一致",
        });
    }
    if (
      value.stopDiagnosis &&
      (value.strategy !== "dual-breakout" ||
        value.stopDiagnosis.cutoff !== value.validationStart ||
        value.risk?.fraction !== 0.01 ||
        value.risk.maxWeight !== 0.2 ||
        value.holdingDays !== 60 ||
        Object.entries(diagnosisTemplate()).some(
          ([k, v]) =>
            JSON.stringify(
              value.management?.[k as keyof typeof value.management],
            ) !== JSON.stringify(v),
        ) ||
        (value.stopDiagnosis &&
          Object.keys(value.management ?? {}).some(
            (k) => !(k in diagnosisTemplate()),
          )))
    )
      context.addIssue({
        code: "custom",
        message: "诊断须同双突破1%/20%/60日及3%基线，冻结于验证起点",
      });
    if (
      value.management?.contextRisk &&
      (value.strategy !== "dual-breakout" ||
        value.risk?.fraction !== 0.02 ||
        value.risk?.maxWeight !== 0.2 ||
        value.holdingDays !== 60 ||
        value.maxPositions !==
          contextRiskMaxPositions(value.management.contextRisk))
    )
      context.addIssue({
        code: "custom",
        message:
          "人工事件预设须双突破、2%风险、20%单股、对应持仓数、60交易日上限",
      });
    if (
      value.management?.growthIntraday === "RK-C-swing-system" &&
      (value.risk?.fraction !== 0.01 ||
        value.risk.maxWeight !== 0.2 ||
        value.holdingDays !== 60)
    )
      context.addIssue({
        code: "custom",
        message: "波段组合须1%风险/20%市值/60日上限",
      });
    if (value.management?.riskPreset) {
      const p = riskPresetParameters(value.management.riskPreset);
      if (
        value.strategy !== riskPresetBase(value.management.riskPreset) ||
        value.risk?.fraction !== p.fraction ||
        value.risk?.maxWeight !== p.maxWeight ||
        value.holdingDays !== 60
      )
        context.addIssue({
          code: "custom",
          message: "规模演化预设须双突破、对应固定风险/市值参数与60交易日上限",
        });
    }
    if (
      value.management?.volatilityStop &&
      (value.strategy !== "dual-breakout" ||
        value.risk?.fraction !== 0.01 ||
        value.risk?.maxWeight !== 0.2 ||
        value.holdingDays !== 60)
    )
      context.addIssue({
        code: "custom",
        message: "波动止损预设须双突破、1%风险、20%单股上限及60交易日持有上限",
      });
    if (
      value.management?.swingDiscipline &&
      (value.strategy !== "dual-breakout" ||
        !value.risk ||
        value.risk.fraction > 0.03 ||
        value.risk.maxWeight > 0.2 ||
        value.maxPositions > 3)
    )
      context.addIssue({
        code: "custom",
        message: "波段管理需双突破基线且风险≤3%、单股≤20%、最多3只",
      });
    if (value.management?.growthDaily) {
      const id = value.management.growthDaily;
      if (value.strategy !== growthDailyBase(id))
        context.addIssue({
          code: "custom",
          path: ["strategy"],
          message: "日线具名方法须使用对应价量基线",
        });
      const standard = id === "SE-P-standard";
      if (
        value.risk?.fraction! > (standard ? 0.02 : 0.015) ||
        value.risk?.maxWeight! > (standard ? 0.3 : 0.25) ||
        value.maxPositions > (standard ? 8 : 5)
      )
        context.addIssue({
          code: "custom",
          path: ["risk"],
          message: "具名仓位版本超过风险、单股或持仓数上限",
        });
    }
    if (value.management?.growthIntraday) {
      if (value.start < "2000-01-04" || value.end > "2022-11-30")
        context.addIssue({
          code: "custom",
          path: ["end"],
          message: "五分钟研究窗口仅2000-01-04至2022-11-30",
        });
      if (
        value.strategy !== growthIntradayBase(value.management.growthIntraday)
      )
        context.addIssue({
          code: "custom",
          path: ["strategy"],
          message: "盘中版本须配合其具名入场基线",
        });
    }
    if (value.management?.sepaElite && !value.strategy.startsWith("sepa-"))
      context.addIssue({
        code: "custom",
        path: ["management", "sepaElite"],
        message: "精英持有规则仅用于SEPA价量策略",
      });
    if (
      (value.management?.kelly?.provenance === "breakout-quality" ||
        value.management?.kelly?.provenance === "rolling-switch30") &&
      value.strategy !== "dual-breakout"
    )
      context.addIssue({
        code: "custom",
        path: ["management", "kelly"],
        message: "五项质量凯利仅适用于基础双突破策略",
      });
    if (
      value.management?.pyramid?.kind === "pullback-50-50" &&
      value.strategy !== "dual-breakout"
    )
      context.addIssue({
        code: "custom",
        path: ["management", "pyramid"],
        message: "50/50回踩分批仅用于有冻结突破位的双突破策略",
      });
    if ((value.strategy === "ma-cross") !== !!value.maParams)
      context.addIssue({
        code: "custom",
        path: ["maParams"],
        message: "均线参数仅适用于双均线策略，选择双均线时必须提供",
      });
    if (
      (value.strategy === "dual-breakout-structure" || !!value.management) !==
      !!value.risk
    )
      context.addIssue({
        code: "custom",
        path: ["risk"],
        message: "启用风控时必须提供风险仓位参数，固定持有策略不接收此参数",
      });
    if (
      value.management &&
      (value.strategy === "dual-breakout-structure" ||
        ((value.management.stop.kind === "structure" ||
          value.management.stop.kind === "structure-atr" ||
          value.management.stop.kind === "max-distance" ||
          value.management.stop.kind === "nearest-stop" ||
          value.management.stop.kind === "structure-auto" ||
          value.management.stop.kind === "breakout-candle" ||
          value.management.stop.kind === "platform-upper") &&
          value.strategy !== "dual-breakout" &&
          !(
            value.strategy === "wy-score-half-kelly" &&
            value.management.stop.kind === "structure"
          )))
    )
      context.addIssue({
        code: "custom",
        path: ["management"],
        message: "组合风控使用基础策略；结构定位仅适用于双突破信号",
      });
    if (value.start >= value.end)
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "结束日期须晚于开始日期",
      });
    if (
      value.validationStart <= value.start ||
      value.validationStart > value.end
    )
      context.addIssue({
        code: "custom",
        path: ["validationStart"],
        message: "保留验证期须位于样本区间内部",
      });
  });
export type ResearchSpec = z.infer<typeof researchSpecSchema>;
export type ResearchEvent = {
  side?: "exit";
  intradayAt?: string;
  symbol: string;
  observedDate: string;
  endpointDate: string;
  key: string;
  strategyVersion: string;
  partition: "development" | "validation" | "tracking";
  evidence: string;
  structureTargets?: { model: string; targets: number[]; confirmedAt: string };
  entryTarget?: number | null;
  initialStop?: number | null;
  stopAtr?: number | null;
  ruleStop?: RuleStop;
  pullbackLevel?: number | null;
  entryPriceRange?: { min: number; max: number };
  /** Earliest input used by the selected variable-length historical shape. */
  historyStart?: string;
};

/** Closed net trade returns only. Unfilled, open and missing samples are
 * reported separately by callers, never inserted as zero-return losses.
 */
export function researchTradeStatistics(netReturns: readonly number[]) {
  if (netReturns.some((value) => !Number.isFinite(value)))
    throw new Error("收益样本含无效值");
  const wins = netReturns.filter((value) => value > 0);
  const losses = netReturns.filter((value) => value < 0);
  const mean = (values: readonly number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  const averageWin = mean(wins),
    averageLoss = mean(losses);
  const sorted = [...netReturns].sort((a, b) => a - b);
  // Linear interpolation on the ordered sample (including flat returns).
  const quantile = (p: number) => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const lower = Math.floor(position),
      upper = Math.ceil(position);
    return (
      sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
    );
  };
  return {
    count: netReturns.length,
    wins: wins.length,
    losses: losses.length,
    flat: netReturns.length - wins.length - losses.length,
    winRate: netReturns.length ? wins.length / netReturns.length : null,
    averageWin,
    averageLoss,
    payoffRatio:
      averageWin !== null && averageLoss !== null
        ? averageWin / Math.abs(averageLoss)
        : null,
    expectancy: mean(netReturns),
    distribution: {
      minimum: sorted[0] ?? null,
      p25: quantile(0.25),
      median: quantile(0.5),
      p75: quantile(0.75),
      maximum: sorted.at(-1) ?? null,
    },
  };
}

export function researchNavStatistics(
  initial: number,
  values: readonly number[],
  annualRiskFreeRate: number,
) {
  if (
    !Number.isFinite(initial) ||
    initial <= 0 ||
    values.some((value) => !Number.isFinite(value) || value <= 0) ||
    !Number.isFinite(annualRiskFreeRate) ||
    annualRiskFreeRate <= -1
  )
    throw new Error("净值参数无效");
  let peak = initial,
    maxDrawdown = 0;
  const returns = values.map((value, index) => {
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, 1 - value / peak);
    return value / (index ? values[index - 1]! : initial) - 1;
  });
  const dailyRiskFree = (1 + annualRiskFreeRate) ** (1 / 252) - 1;
  const mean = returns.length
    ? returns.reduce((sum, value) => sum + value - dailyRiskFree, 0) /
      returns.length
    : 0;
  const variance =
    returns.length > 1
      ? returns.reduce(
          (sum, value) => sum + (value - dailyRiskFree - mean) ** 2,
          0,
        ) /
        (returns.length - 1)
      : 0;
  return {
    maxDrawdown,
    totalReturn: values.length ? values.at(-1)! / initial - 1 : null,
    sharpe: variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : null,
    annualization: 252,
    observations: returns.length,
  };
}
