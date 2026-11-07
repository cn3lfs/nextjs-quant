import { financialMetrics } from "./metrics.js";
import {
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
export type FinancialCondition = {
  field: string;
  operator: "gt" | "gte" | "lt" | "lte";
  threshold: number;
};
export function compareFinancialNumber(
  left: number | null,
  right: number,
  operator: FinancialCondition["operator"],
): boolean | null {
  if (left === null || !Number.isFinite(left) || !Number.isFinite(right))
    return null;
  switch (operator) {
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
  }
}
export function combineFinancialConditions(
  results: readonly (boolean | null)[],
  mode: "all" | "any",
): boolean | null {
  if (!results.length) return null;
  if (mode === "all")
    return results.includes(false)
      ? false
      : results.includes(null)
        ? null
        : true;
  return results.includes(true) ? true : results.includes(null) ? null : false;
}
export function evaluateFinancialConditions(
  reports: readonly FinancialReportSnapshot[],
  conditions: readonly FinancialCondition[],
  mode: "all" | "any",
) {
  const metrics = financialMetrics(reports);
  const details = conditions.map((condition) => {
    const value = condition.field.startsWith("FN")
      ? sourceFinancialValue(reports[0], Number(condition.field.slice(2)))
      : (metrics.find((metric) => metric.id === condition.field)?.value ??
        null);
    return {
      ...condition,
      value,
      matched: compareFinancialNumber(
        value,
        condition.threshold,
        condition.operator,
      ),
      reason: value === null ? "财报、单位、适用性或必要历史期数缺失" : null,
    };
  });
  return {
    matched: combineFinancialConditions(
      details.map((detail) => detail.matched),
      mode,
    ),
    details,
  };
}
