import {
  evaluatePerformance,
  performancePeriods,
  type PerformanceFrequency,
  type PerformancePoint,
} from "./performance.js";
import { evaluateTrades, type TradeCycle } from "./trades.js";

export type PerformanceReportSelection = {
  frequency: PerformanceFrequency;
  year?: number;
  period?: string;
};

export function createPerformanceReport(
  initial: number,
  points: readonly PerformancePoint[],
  trades?: readonly TradeCycle[],
  annualizationDays = 252,
) {
  return {
    version: "performance-report-v2" as const,
    trades: trades === undefined ? null : evaluateTrades(trades),
    overview: evaluatePerformance(
      initial,
      points,
      points[0]?.date,
      annualizationDays,
    ),
    year: performancePeriods(initial, points, "year", annualizationDays),
    quarter: performancePeriods(initial, points, "quarter", annualizationDays),
    month: performancePeriods(initial, points, "month", annualizationDays),
    daily: points.map((point) => ({ ...point })),
  };
}

export function queryPerformanceReport(
  initial: number,
  points: readonly PerformancePoint[],
  input: PerformanceReportSelection,
  trades?: readonly TradeCycle[],
  annualizationDays = 252,
) {
  const overview = evaluatePerformance(
    initial,
    points,
    points[0]?.date,
    annualizationDays,
  );
  if (!["year", "quarter", "month"].includes(input.frequency))
    throw new Error("评价频率无效");
  const years = [
    ...new Set(points.map((p) => Number(p.date.slice(0, 4)))),
  ].reverse();
  const year = input.year ?? years[0] ?? null;
  if (input.year !== undefined && !years.includes(input.year))
    throw new Error("所选年份没有评价样本");
  const periods = performancePeriods(
    initial,
    points,
    input.frequency,
    annualizationDays,
  ).filter((p) => p.year === year);
  const selected = input.period
    ? (periods.find((p) => p.key === input.period) ?? null)
    : null;
  if (input.period && !selected)
    throw new Error("所选期间不属于当前年份或频率");
  const months = performancePeriods(initial, points, "month", annualizationDays)
    .filter((p) => p.year === year)
    .map((p) => ({ key: p.key, value: p.evaluation.totalReturn.value }));
  return {
    overview,
    trades: trades === undefined ? null : evaluateTrades(trades),
    years,
    year,
    months,
    periods,
    selected,
  };
}
export type PerformanceReportPage = ReturnType<typeof queryPerformanceReport>;
