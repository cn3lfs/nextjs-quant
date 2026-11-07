import type { Bar } from "../bars.js";
import { trendFactors } from "./trend.js";
import { momentumFactors } from "./momentum.js";
import { volatilityFactors } from "./volatility.js";
import { volumeFactors } from "./volume.js";
import { breakoutFactors } from "./breakout.js";
import { finiteValue, type FactorDefinition } from "./model.js";
import { qlibFactors } from "./qlib-alpha158.js";
import { alpha101Factors } from "./alpha101.js";
export { qlibAlpha158Variants } from "./qlib-alpha158.js";
export type { FactorDefinition, FactorParameter } from "./model.js";

const definitions = {
  ...trendFactors,
  ...momentumFactors,
  ...volatilityFactors,
  ...volumeFactors,
  ...breakoutFactors,
  ...qlibFactors,
  ...alpha101Factors,
};
export type FactorId = keyof typeof definitions;
export type FactorSpec = { id: FactorId; parameters?: Record<string, number> };
export const factorIds = Object.keys(definitions) as FactorId[];
export const factorCatalog = factorIds.map((id) => {
  const {
    calculate: _calculate,
    lookback: _lookback,
    ...metadata
  } = definitions[id] as FactorDefinition;
  return { id, ...metadata };
});

/** Resolve once at the boundary: unknown keys never silently become defaults. */
export function resolveFactor(spec: FactorSpec) {
  if (!Object.hasOwn(definitions, spec.id))
    throw new Error(`未知因子：${spec.id}`);
  const definition: FactorDefinition = definitions[spec.id];
  const parameters: Record<string, number> = {};
  for (const key of Object.keys(spec.parameters ?? {})) {
    if (!Object.hasOwn(definition.parameters, key))
      throw new Error(`${definition.label} 不支持参数 ${key}`);
  }
  for (const [key, rule] of Object.entries(definition.parameters)) {
    const value = spec.parameters?.[key] ?? rule.default;
    if (
      !Number.isFinite(value) ||
      value < rule.min ||
      value > rule.max ||
      (rule.integer && !Number.isInteger(value))
    )
      throw new Error(
        `${definition.label} 的 ${rule.label} 须为 ${rule.min} 至 ${rule.max}${rule.integer ? "的整数" : ""}`,
      );
    parameters[key] = value;
  }
  if (parameters.fast !== undefined && parameters.fast >= parameters.slow!)
    throw new Error("MACD 快周期须小于慢周期");
  return {
    definition,
    spec: { id: spec.id, parameters },
    lookbackBars: definition.lookback(parameters),
  };
}
export function calculateFactor(bars: readonly Bar[], spec: FactorSpec) {
  const resolved = resolveFactor(spec);
  return {
    spec: resolved.spec,
    lookbackBars: resolved.lookbackBars,
    values: resolved.definition
      .calculate(bars, resolved.spec.parameters)
      .map((v) => (v === null ? null : finiteValue(v))),
  };
}
