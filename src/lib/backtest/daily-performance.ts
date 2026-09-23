import type { ReviewValue } from "../portfolio/trade-review";

export const performanceBases = ["compound", "simple"] as const;
export type PerformanceBasis = (typeof performanceBases)[number];
const defaultYearlyDays = 252;
export type DailyPerformanceInput = {
  /** 日期升序；null 不参与计算，只计入覆盖信息。 */
  returns: readonly (number | null)[];
  basis?: PerformanceBasis;
  yearlyDays?: number;
  /** 保留调用方口径信息；sharpeWbt 固定 rf=0，不使用此参数扣息。 */
  annualRiskFreeRate?: number;
};
export type DailyPerformance = {
  basis: PerformanceBasis;
  yearlyDays: number;
  annualRiskFreeRate: number;
  coverage: {
    observedDays: number;
    availableDays: number;
    nullDays: number;
    zeroReturnDays: number;
  };
  totalReturn: ReviewValue;
  annualReturn: ReviewValue;
  sharpeWbt: ReviewValue;
  maxDrawdown: ReviewValue;
  calmar: ReviewValue;
  dailyWinRate: ReviewValue;
  dailyPayoffRatio: ReviewValue;
  dailyEdge: ReviewValue;
  annualVolatility: ReviewValue;
  downsideVolatility: ReviewValue;
  nonzeroCoverage: ReviewValue;
  breakEvenPoint: ReviewValue;
  newHighInterval: ReviewValue;
  newHighRatio: ReviewValue;
  drawdownRisk: ReviewValue;
  regressionAnnualReturn: ReviewValue;
  lengthAdjustedAverageDrawdown: ReviewValue;
};
const metric = (value: number | null, reason: string): ReviewValue =>
  value === null
    ? { value: null, reason }
    : Number.isFinite(value)
      ? { value, reason: null }
      : { value: null, reason: "计算结果非有限值，数值溢出" };
const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);
const std = (values: readonly number[]) => {
  // 平移后求均值，常数序列精确得到零；不以 EPSILON 吞掉真实微小波动。
  const offsets = values.map((value) => value - values[0]!);
  const center = mean(offsets);
  return Math.sqrt(mean(offsets.map((value) => (value - center) ** 2)));
};

function topDrawdownLength(curve: readonly number[], basis: PerformanceBasis) {
  let remaining = curve.map((value, index) => ({ value, index }));
  let length = 0;
  for (let rank = 0; rank < 5 && remaining.length; rank++) {
    let peak = basis === "compound" ? 1 : 0;
    let peakIndex = -1;
    let depth = 0;
    let start = -1;
    let valley = -1;
    for (let i = 0; i < remaining.length; i++) {
      const value = remaining[i]!.value;
      if (value >= peak) {
        peak = value;
        peakIndex = i;
      }
      const drawdown = basis === "compound" ? 1 - value / peak : peak - value;
      if (drawdown > depth) {
        depth = drawdown;
        start = peakIndex;
        valley = i;
      }
    }
    if (valley < 0) break;
    // §3 全负三日表给 2/(5*yearlyDays)：期初本金参与深度，虚拟 bar 不计长度。
    length += remaining[valley]!.index - remaining[Math.max(start, 0)]!.index;
    const peakValue =
      start < 0 ? (basis === "compound" ? 1 : 0) : remaining[start]!.value;
    let recovery = valley + 1;
    while (
      recovery < remaining.length &&
      remaining[recovery]!.value < peakValue
    )
      recovery++;
    // 剥离整段峰至恢复日（含端点）；未恢复则剥离至末日，再寻找下一深回撤。
    remaining = remaining.filter((_, i) => i < start || i > recovery);
  }
  return length;
}

/** U1 §2：新核只追加；旧 sharpe / sortino 不由这里替代。 */
export function dailyPerformance(
  input: DailyPerformanceInput,
): DailyPerformance {
  const basis = input.basis ?? "compound";
  const yearlyDays = input.yearlyDays ?? defaultYearlyDays;
  const annualRiskFreeRate = input.annualRiskFreeRate ?? 0.02;
  if (!performanceBases.includes(basis)) throw new Error("收益口径无效");
  if (!Number.isFinite(yearlyDays) || yearlyDays <= 0)
    throw new Error("年化天数必须为正有限数");
  if (!Number.isFinite(annualRiskFreeRate) || annualRiskFreeRate <= -1)
    throw new Error("无风险利率无效");
  if (input.returns.some((r) => r !== null && !Number.isFinite(r)))
    throw new Error("日收益必须为有限数或 null");
  const returns = input.returns.filter((r): r is number => r !== null);
  const n = returns.length;
  const coverage = {
    observedDays: input.returns.length,
    availableDays: n,
    nullDays: input.returns.length - n,
    zeroReturnDays: returns.filter((r) => r === 0).length,
  };
  const empty = "无可得日收益";
  // 任务书 §3 全零=无可得日收益与 §2.1/2.3 不符；按有效零收益计算，避免丢失已知量。
  const validReturns = basis === "simple" || returns.every((r) => r >= -1);
  let value = basis === "compound" ? 1 : 0;
  const curve = returns.map((r) => {
    value = basis === "compound" ? value * (1 + r) : value + r;
    return value;
  });
  const validCurve = validReturns && curve.every(Number.isFinite);
  const curveReason = !n
    ? empty
    : !validReturns
      ? "复利日收益低于 -100%，净值曲线无定义"
      : "累计净值溢出，曲线指标不可估";
  const total = n && validCurve ? value - Number(basis === "compound") : null;
  const annual =
    total === null
      ? null
      : basis === "compound"
        ? (1 + total) ** (yearlyDays / n) - 1
        : (total / n) * yearlyDays;
  let peak = basis === "compound" ? 1 : 0;
  let maxDrawdown = 0;
  let underwater = 0;
  let longest = 0;
  let highs = 0;
  // §2.3 排除起始 bar 与 §3 全负三日间隔=3 不符；首亏计入，只排除虚拟本金点。
  for (const point of curve) {
    peak = Math.max(peak, point);
    maxDrawdown = Math.max(
      maxDrawdown,
      basis === "compound" ? 1 - point / peak : peak - point,
    );
    if (point < peak) longest = Math.max(longest, ++underwater);
    else {
      underwater = 0;
      highs++;
    }
  }
  const deviation = n ? std(returns) : null;
  const volatility =
    deviation === null ? null : deviation * Math.sqrt(yearlyDays);
  const wins = returns.filter((r) => r >= 0);
  const losses = returns.filter((r) => r < 0);
  // 任务书 §3 全负盈亏比=0 与 §2.3 的空集合均值不符；按 §2.4 无定义留空。
  const payoffReason = !n
    ? empty
    : !losses.length
      ? "无亏损日，盈亏比不可估"
      : "无非负收益日，盈亏比不可估";
  const payoff =
    wins.length && losses.length ? mean(wins) / Math.abs(mean(losses)) : null;
  const winRate = n ? wins.length / n : null;
  let sortedSum = 0;
  const positiveIndex = [...returns]
    .sort((a, b) => a - b)
    .findIndex((r) => (sortedSum += r) > 0);
  const xMean = (n - 1) / 2;
  // §2.3 仅写单利 cum 与 §2.2 双曲线不符；复利回归沿用所选净值，保持曲线口径一致。
  const yMean = mean(curve);
  let covariance = 0;
  let xVariance = 0;
  for (let i = 0; i < n; i++) {
    covariance += (i - xMean) * (curve[i]! - yMean);
    xVariance += (i - xMean) ** 2;
  }
  const curveMetric = (result: number) =>
    metric(n && validCurve ? result : null, curveReason);
  return {
    basis,
    yearlyDays,
    annualRiskFreeRate,
    coverage,
    totalReturn: metric(total, curveReason),
    annualReturn: metric(
      annual,
      annual !== null ? "年化收益溢出" : curveReason,
    ),
    sharpeWbt: metric(
      deviation !== null && Number.isFinite(deviation) && deviation > 0
        ? (mean(returns) / deviation) * Math.sqrt(yearlyDays)
        : null,
      !n
        ? empty
        : deviation !== null && !Number.isFinite(deviation)
          ? "收益标准差溢出，夏普不可估"
          : "收益标准差为零，夏普无定义",
    ),
    maxDrawdown: curveMetric(maxDrawdown),
    calmar: metric(
      annual !== null && maxDrawdown > 0 ? annual / maxDrawdown : null,
      !n || !validCurve ? curveReason : "最大回撤为零，卡玛无定义",
    ),
    dailyWinRate: metric(winRate, empty),
    dailyPayoffRatio: metric(payoff, payoffReason),
    dailyEdge: metric(
      payoff !== null && winRate !== null
        ? winRate * payoff - (1 - winRate)
        : null,
      payoffReason,
    ),
    annualVolatility: metric(volatility, empty),
    downsideVolatility: metric(
      losses.length ? std(losses) * Math.sqrt(yearlyDays) : null,
      n ? "无亏损日，下行波动率不可估" : empty,
    ),
    nonzeroCoverage: metric(
      n ? (n - coverage.zeroReturnDays) / n : null,
      empty,
    ),
    breakEvenPoint: metric(
      n && Number.isFinite(sortedSum)
        ? positiveIndex < 0
          ? 1
          : (positiveIndex + 1) / n
        : null,
      n ? "排序累计收益溢出，盈亏平衡点不可估" : empty,
    ),
    newHighInterval: curveMetric(longest),
    newHighRatio: curveMetric(highs / n),
    drawdownRisk: metric(
      n &&
        validCurve &&
        volatility !== null &&
        Number.isFinite(volatility) &&
        volatility > 0
        ? maxDrawdown / volatility
        : null,
      !n || !validCurve
        ? curveReason
        : volatility !== null && !Number.isFinite(volatility)
          ? "年化波动率溢出，回撤风险不可估"
          : "年化波动率为零，回撤风险无定义",
    ),
    regressionAnnualReturn: metric(
      n >= 2 && validCurve ? (covariance / xVariance) * yearlyDays : null,
      !validCurve ? curveReason : "不足两个可得日收益，回归斜率无定义",
    ),
    lengthAdjustedAverageDrawdown: curveMetric(
      topDrawdownLength(curve, basis) / 5 / yearlyDays,
    ),
  };
}
