import type { Bar } from "../bars.js";
import type { IndicatorValue } from "../indicators.js";

export type FactorParameter = {
  label: string;
  default: number;
  min: number;
  max: number;
  integer: boolean;
};
export type FactorDefinition = {
  label: string;
  category: "趋势" | "动量" | "波动" | "量价" | "突破";
  unit: "价格" | "%" | "倍" | "指数" | "成交量" | "比例";
  description: string;
  source?: {
    name: string;
    url: string;
    revision: string;
    originalName: string;
    notes: string;
  };
  parameters: Record<string, FactorParameter>;
  lookback: (parameters: Record<string, number>) => number;
  calculate: (
    bars: readonly Bar[],
    parameters: Record<string, number>,
  ) => IndicatorValue[];
};
export const periodParameter = (value: number, min = 1): FactorParameter => ({
  label: "周期（根）",
  default: value,
  min,
  max: 250,
  integer: true,
});
export const finiteValue = (value: number): IndicatorValue =>
  Number.isFinite(value) ? value : null;
export const positiveValue = (value: number): IndicatorValue =>
  Number.isFinite(value) && value > 0 ? value : null;
export function ratio(
  value: IndicatorValue,
  base: IndicatorValue,
  scale = 1,
): IndicatorValue {
  return value === null || base === null || base === 0
    ? null
    : finiteValue((value / base) * scale);
}
