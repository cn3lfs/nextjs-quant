import { dailyPerformance, type DailyPerformance } from "./daily-performance";
import {
  alignPeriodInput,
  aSharePeriodTradingDays,
  type PeriodInput,
} from "./period-performance";

export const rollingPerformanceDefaults = {
  window: aSharePeriodTradingDays.past3m,
  minimumCoverage: 0.6,
} as const;

export type RollingPoint = DailyPerformance & {
  endDate: string;
  startDate: string;
  tradingDays: number;
  insufficientCoverage: boolean;
};
export type RollingPerformanceInput = PeriodInput & {
  window?: number;
  minPeriods?: number;
};

/** invariants §1 U2/U10：按交易日历切片；null 原样交给 U1。 */
export function rollingPerformance(
  input: RollingPerformanceInput,
): RollingPoint[] {
  const window = input.window ?? rollingPerformanceDefaults.window;
  const minPeriods = input.minPeriods ?? window;
  if (
    !Number.isSafeInteger(window) ||
    window < 1 ||
    !Number.isSafeInteger(minPeriods) ||
    minPeriods < 1 ||
    minPeriods > window
  )
    throw new Error("窗口与最少交易日数必须为正整数，且最少日数不能超过窗口");
  const aligned = alignPeriodInput(input);
  // 即使不足起算日数，也不让非法 U1 参数静默通过。
  dailyPerformance({ ...input, returns: [] });
  const points: RollingPoint[] = [];
  for (let end = minPeriods; end <= aligned.dates.length; end++) {
    const start = Math.max(0, end - window);
    const metrics = dailyPerformance({
      ...input,
      returns: aligned.returns.slice(start, end),
    });
    points.push({
      ...metrics,
      startDate: aligned.dates[start]!,
      endDate: aligned.dates[end - 1]!,
      tradingDays: end - start,
      insufficientCoverage:
        metrics.coverage.availableDays / metrics.coverage.observedDays <
        rollingPerformanceDefaults.minimumCoverage,
    });
  }
  return points;
}

export const rollingMetrics = [
  ["totalReturn", "累计收益", true],
  ["annualReturn", "年化收益", true],
  ["sharpeWbt", "夏普（wbt）", false],
  ["maxDrawdown", "最大回撤", true],
  ["calmar", "卡玛", false],
  ["dailyWinRate", "日胜率", true],
  ["dailyPayoffRatio", "日盈亏比", false],
  ["dailyEdge", "日赢面", false],
  ["annualVolatility", "年化波动率", true],
  ["downsideVolatility", "下行波动率", true],
  ["nonzeroCoverage", "非零覆盖率", true],
  ["breakEvenPoint", "盈亏平衡点", true],
  ["newHighInterval", "新高间隔", false],
  ["newHighRatio", "新高占比", true],
  ["drawdownRisk", "回撤风险", false],
  ["regressionAnnualReturn", "回归年化收益", true],
  ["lengthAdjustedAverageDrawdown", "长度调整平均回撤", false],
] as const satisfies readonly (readonly [
  keyof DailyPerformance,
  string,
  boolean,
])[];

export const rollingChartMetrics = [
  "sharpeWbt",
  "maxDrawdown",
  "annualReturn",
] as const;
export type RollingCurvePoint = Pick<
  RollingPoint,
  "endDate" | "insufficientCoverage"
> &
  Record<(typeof rollingChartMetrics)[number], number | null>;

/** 分段画线，不能跨 null 缺口连线。这里只投影数值，不计算指标。 */
export function rollingCurveSegments(
  points: readonly RollingCurvePoint[],
  key: (typeof rollingChartMetrics)[number],
) {
  const segments: { date: string; value: number }[][] = [];
  let segment: { date: string; value: number }[] = [];
  for (const point of points) {
    const value = point[key];
    if (value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push({ date: point.endDate, value });
  }
  if (segment.length) segments.push(segment);
  return segments;
}
