import {
  alphaBuiltins,
  alphaEvaluationInputSchema,
  alphaExperimentSchema,
  alphaTargetOptionsSchema,
  type AlphaExperiment,
  type AlphaTargetOptions,
} from "~/lib/research/alpha-experiment";
import type {
  FactorCompositeRecord,
  UpsertFactorCompositeInput,
} from "~/server/db/factor-composite-repository";

export type AlphaDirection = 1 | -1;
export type AlphaWeighting = AlphaExperiment["weightingMethod"];
export type AlphaWinsorize = AlphaExperiment["winsorizeMethod"];
export type AlphaNeutralization = AlphaExperiment["neutralizationMode"];
export type AlphaQuantiles = AlphaExperiment["quantiles"];
export type AlphaCostScenario = "base" | "double-cost";

export type AlphaFactorDraft = {
  factorId: string;
  formula?: string;
  parameters?: AlphaExperiment["factors"][number]["parameters"];
  direction: AlphaDirection;
  weight: number;
};

export type AlphaDraft = {
  id: string;
  name: string;
  description: string;
  factors: AlphaFactorDraft[];
  weightingMethod: AlphaWeighting;
  winsorizeMethod: AlphaWinsorize;
  neutralizationMode: AlphaNeutralization;
  start: string;
  end: string;
  horizons: number[];
  quantiles: AlphaQuantiles;
  minTradingDays: number;
  liquidityWindow: number;
  minAverageAmount: number;
  icirWindow: number;
  icirMinSamples: number;
  icirHorizon: number;
  madK: number;
  quantileTail: number;
};

/** Top-N target controls belong to the backtest section but freeze inside evaluation. */
export type AlphaBacktestForm = {
  topN: number;
  every: number;
  maxWeight: number;
  costScenario: AlphaCostScenario;
  initial: number;
};

const builtinLabels: Record<(typeof alphaBuiltins)[number], string> = {
  momentum: "动量 · 20 日收益",
  reversal: "短期反转 · 5 日",
  volatility: "波动率 · 20 日",
  turnover: "换手率 · GBBQ 流通股",
  amount: "当日成交额",
};

export const alphaBuiltinOptions = alphaBuiltins.map((id) => ({
  id,
  label: builtinLabels[id],
}));

export function builtinLabel(id: string) {
  return (builtinLabels as Record<string, string | undefined>)[id];
}

function localIso(date: Date) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function defaultAlphaDraft(): AlphaDraft {
  const today = new Date();
  return {
    id: "",
    name: "多因子 Alpha 组合",
    description: "",
    factors: [
      {
        factorId: "momentum",
        direction: 1,
        weight: 1,
      },
      {
        factorId: "volatility",
        direction: 1,
        weight: 1,
      },
    ],
    weightingMethod: "equal",
    winsorizeMethod: "mad",
    neutralizationMode: "none",
    start: localIso(new Date(today.getFullYear() - 2, today.getMonth(), 1)),
    end: localIso(today),
    horizons: [1, 5, 10, 20],
    quantiles: 5,
    minTradingDays: 60,
    liquidityWindow: 20,
    minAverageAmount: 0,
    icirWindow: 60,
    icirMinSamples: 10,
    icirHorizon: 5,
    madK: 3,
    quantileTail: 0.01,
  };
}

export type AlphaDraftBuild =
  | { ok: true; config: AlphaExperiment; error: null }
  | { ok: false; config: null; error: string };

/** Validate the draft with the frozen contract before it reaches the worker. */
export function buildAlphaExperiment(draft: AlphaDraft): AlphaDraftBuild {
  if (!draft.factors.length)
    return { ok: false, config: null, error: "至少添加一个因子" };
  if (
    draft.factors.some(
      (factor) => factor.formula !== undefined && !factor.formula.trim(),
    )
  )
    return {
      ok: false,
      config: null,
      error: "请填写每个自定义因子的 TDX 公式",
    };
  if (
    draft.factors.some(
      (factor) => !Number.isFinite(factor.weight) || factor.weight < 0,
    )
  )
    return { ok: false, config: null, error: "因子权重须为非负数" };
  if (!draft.horizons.length)
    return { ok: false, config: null, error: "至少选择一个持有期" };
  const parsed = alphaExperimentSchema.safeParse({
    factors: draft.factors.map((factor) => ({
      factorId: factor.factorId.trim(),
      direction: factor.direction,
      weight: factor.weight,
      ...(factor.formula === undefined ? {} : { formula: factor.formula }),
      parameters: factor.parameters ?? {},
    })),
    weightingMethod: draft.weightingMethod,
    winsorizeMethod: draft.winsorizeMethod,
    neutralizationMode: draft.neutralizationMode,
    horizons: draft.horizons,
    quantiles: draft.quantiles,
    minTradingDays: draft.minTradingDays,
    liquidityWindow: draft.liquidityWindow,
    minAverageAmount: draft.minAverageAmount,
    icirWindow: draft.icirWindow,
    icirMinSamples: draft.icirMinSamples,
    icirHorizon: draft.icirHorizon,
    madK: draft.madK,
    quantileTail: draft.quantileTail,
  });
  if (!parsed.success)
    return {
      ok: false,
      config: null,
      error: parsed.error.issues[0]?.message ?? "因子配置无效",
    };
  return { ok: true, config: parsed.data, error: null };
}

export function targetOptionsFromForm(form: AlphaBacktestForm) {
  return alphaTargetOptionsSchema.safeParse({
    topN: form.topN,
    every: form.every,
    maxWeight: form.maxWeight / 100,
  });
}

export function sameTargetOptions(
  a: AlphaTargetOptions,
  b: AlphaTargetOptions,
) {
  return (
    a.topN === b.topN && a.every === b.every && a.maxWeight === b.maxWeight
  );
}

export function evaluationInput(
  draft: AlphaDraft,
  options: AlphaTargetOptions,
) {
  return alphaEvaluationInputSchema.safeParse({
    start: draft.start,
    end: draft.end,
    targetOptions: options,
  });
}

function numberParameter(
  parameters: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
) {
  const value = parameters?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function horizonsParameter(
  parameters: Record<string, unknown> | undefined,
  fallback: number[],
) {
  const value = parameters?.horizons;
  if (!Array.isArray(value)) return fallback;
  const horizons = value.filter(
    (item): item is number =>
      typeof item === "number" &&
      Number.isInteger(item) &&
      item > 0 &&
      item <= 60,
  );
  return horizons.length ? [...new Set(horizons)] : fallback;
}

/** Saved composites freeze the experiment parameters, not the evaluation dates. */
export function draftFromComposite(
  record: FactorCompositeRecord,
  current: AlphaDraft,
): AlphaDraft {
  const defaults = defaultAlphaDraft();
  const parameters = record.config.parameters;
  const quantiles = parameters?.quantiles === 10 ? 10 : 5;
  return {
    ...defaults,
    start: current.start,
    end: current.end,
    id: record.id,
    name: record.name,
    description: record.description,
    factors: record.config.factors.map((factor) => ({
      factorId: factor.factorId,
      ...(factor.formula ? { formula: factor.formula } : {}),
      parameters: Object.fromEntries(
        Object.entries(factor.parameters ?? {}).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      ),
      direction: factor.direction,
      weight: factor.weight ?? 1,
    })),
    weightingMethod: record.weightingMethod,
    winsorizeMethod: record.winsorizeMethod,
    neutralizationMode: record.neutralizationMode,
    horizons: horizonsParameter(parameters, defaults.horizons),
    quantiles,
    minTradingDays: numberParameter(
      parameters,
      "minTradingDays",
      defaults.minTradingDays,
    ),
    liquidityWindow: numberParameter(
      parameters,
      "liquidityWindow",
      defaults.liquidityWindow,
    ),
    minAverageAmount: numberParameter(
      parameters,
      "minAverageAmount",
      defaults.minAverageAmount,
    ),
    icirWindow: numberParameter(parameters, "icirWindow", defaults.icirWindow),
    icirMinSamples: numberParameter(
      parameters,
      "icirMinSamples",
      defaults.icirMinSamples,
    ),
    icirHorizon: numberParameter(
      parameters,
      "icirHorizon",
      defaults.icirHorizon,
    ),
    madK: numberParameter(parameters, "madK", defaults.madK),
    quantileTail: numberParameter(
      parameters,
      "quantileTail",
      defaults.quantileTail,
    ),
  };
}

export function compositeSavePayload(
  draft: AlphaDraft,
  experiment: AlphaExperiment,
): UpsertFactorCompositeInput {
  const {
    factors,
    weightingMethod,
    winsorizeMethod,
    neutralizationMode,
    ...parameters
  } = experiment;
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    description: draft.description,
    weightingMethod,
    winsorizeMethod,
    neutralizationMode,
    config: {
      factors: factors.map(
        ({ factorId, direction, formula, weight, parameters }) => ({
          factorId,
          direction,
          ...(formula === undefined ? {} : { formula }),
          ...(weight === undefined ? {} : { weight }),
          ...(Object.keys(parameters).length ? { parameters } : {}),
        }),
      ),
      parameters,
    },
  };
}
