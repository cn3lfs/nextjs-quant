import { finiteValue } from "./model.js";
import type { IndicatorValue } from "../indicators.js";

export function rolling(
  values: readonly IndicatorValue[],
  n: number,
  calculate: (window: number[]) => IndicatorValue,
) {
  return values.map((_, i) => {
    if (i + 1 < n) return null;
    const window = values.slice(i + 1 - n, i + 1);
    return window.some((v) => v === null || !Number.isFinite(v))
      ? null
      : calculate(window as number[]);
  });
}
export const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);
export function percentileRank(values: number[]) {
  const current = values.at(-1)!;
  const below = values.filter((v) => v < current).length;
  const equal = values.filter((v) => v === current).length;
  return (below + (equal + 1) / 2) / values.length;
}
export function correlation(a: number[], b: number[]) {
  const meanA = mean(a),
    meanB = mean(b);
  let covariance = 0,
    varianceA = 0,
    varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]! - meanA,
      y = b[i]! - meanB;
    covariance += x * y;
    varianceA += x * x;
    varianceB += y * y;
  }
  return varianceA === 0 || varianceB === 0
    ? null
    : finiteValue(covariance / Math.sqrt(varianceA * varianceB));
}
export function rollingCorrelation(
  a: readonly IndicatorValue[],
  b: readonly IndicatorValue[],
  n: number,
) {
  return a.map((_, i) => {
    if (i + 1 < n) return null;
    const left = a.slice(i + 1 - n, i + 1),
      right = b.slice(i + 1 - n, i + 1);
    if ([...left, ...right].some((v) => v === null || !Number.isFinite(v)))
      return null;
    return correlation(left as number[], right as number[]);
  });
}
