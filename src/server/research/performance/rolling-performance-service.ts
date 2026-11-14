import { z } from "zod";
import { performanceBases } from "~/lib/backtest/daily-performance";
import {
  rollingPerformance,
  rollingPerformanceDefaults,
  rollingMetrics,
  type RollingPoint,
  type RollingPerformanceInput,
  type RollingCurvePoint,
} from "~/lib/backtest/rolling-performance";
import type { replayTradeReview } from "../../portfolio/trade-review-service";

const rollingSortKeys = [
  "endDate",
  "startDate",
  "tradingDays",
  "coverage",
  "insufficientCoverage",
  ...rollingMetrics.map(([key]) => key),
] as const;
export const rollingPageSchema = z.object({
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(100).default(10),
  sort: z.enum(rollingSortKeys).default("endDate"),
  desc: z.boolean().default(true),
  basis: z.enum(performanceBases).default("compound"),
  window: z
    .number()
    .int()
    .min(1)
    .max(1000000)
    .default(rollingPerformanceDefaults.window),
  minPeriods: z.number().int().min(1).max(1000000).optional(),
});
export type RollingPageInput = z.infer<typeof rollingPageSchema>;

export function pageRollingPerformance(
  input: RollingPerformanceInput,
  page: RollingPageInput,
  note: string,
) {
  const points = rollingPerformance({
    ...input,
    basis: page.basis,
    window: page.window,
    minPeriods: page.minPeriods,
  });
  const curve: RollingCurvePoint[] = points.map((point) => ({
    endDate: point.endDate,
    insufficientCoverage: point.insufficientCoverage,
    sharpeWbt: point.sharpeWbt.value,
    maxDrawdown: point.maxDrawdown.value,
    annualReturn: point.annualReturn.value,
  }));
  const value = (point: RollingPoint) => {
    if (page.sort === "coverage") return point.coverage.observedDays;
    const field = point[page.sort];
    return typeof field === "object" ? field.value : field;
  };
  const sorted = [...points].sort((a, b) => {
    const x = value(a),
      y = value(b);
    if (x === null || y === null)
      return x === y ? a.endDate.localeCompare(b.endDate) : x === null ? 1 : -1;
    const order =
      typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
    return (page.desc ? -order : order) || a.endDate.localeCompare(b.endDate);
  });
  return {
    rows: sorted.slice(
      page.pageIndex * page.pageSize,
      (page.pageIndex + 1) * page.pageSize,
    ),
    rowCount: points.length,
    curve,
    insufficientCount: points.filter((point) => point.insufficientCoverage)
      .length,
    window: page.window,
    minPeriods: page.minPeriods ?? page.window,
    basis: page.basis,
    yearlyDays: points[0]?.yearlyDays ?? null,
    note,
  };
}

export function tradeReviewRollingPage(
  snapshot: ReturnType<typeof replayTradeReview>,
  page: RollingPageInput,
  tradingDays: readonly string[] = snapshot.replayInput.nav.tradingDays,
) {
  return pageRollingPerformance(
    {
      dates: snapshot.nav.days.map((day) => day.date),
      returns: snapshot.nav.days.map((day) => day.dailyReturn.value),
      tradingDays,
      annualRiskFreeRate: snapshot.replayInput.nav.annualRiskFreeRate,
    },
    page,
    "账户日度 TWR，截止最后流水日；缺失由 U1 剔除并披露覆盖，不代表跨中断连续业绩。夏普固定 rf=0；滚动结果只供观察，不驱动准入或自动调参。",
  );
}
