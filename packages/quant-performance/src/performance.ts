/** Host-independent daily performance. No trading, IO or archive mutation. */
export type PerformanceMetric = { value: number | null; reason: string | null };
export type PerformancePoint = {
  date: string;
  value: number;
  benchmarkReturn?: number;
};
export type DrawdownEpisode = {
  peakDate: string;
  valleyDate: string;
  recoveryDate: string | null;
  depth: number;
  recoveryDays: number | null;
  observedRecoveryDays: number;
  underwaterDays: number;
};
export type PerformanceEvaluation = {
  version: "daily-performance-v1";
  start: string | null;
  end: string | null;
  initial: number;
  days: number;
  shortSample: boolean;
  totalReturn: PerformanceMetric;
  annualReturn: PerformanceMetric;
  benchmarkReturn: PerformanceMetric;
  excessReturn: PerformanceMetric;
  sharpe: PerformanceMetric;
  sortino: PerformanceMetric;
  informationRatio: PerformanceMetric;
  annualVolatility: PerformanceMetric;
  trackingError: PerformanceMetric;
  maxDrawdown: PerformanceMetric;
  calmar: PerformanceMetric;
  recoveryDays: PerformanceMetric;
  longestUnderwaterDays: PerformanceMetric;
  maxDrawdownEpisode: DrawdownEpisode | null;
};
export type PerformanceFrequency = "year" | "quarter" | "month";
export type PerformancePeriod = {
  key: string;
  year: number;
  boundary: boolean;
  evaluation: PerformanceEvaluation;
};
const yearlyDays = 252;
const dailyRiskFree = 1.02 ** (1 / yearlyDays) - 1;
const metric = (value: number | null, reason = "计算结果非有限") =>
  value !== null && Number.isFinite(value)
    ? { value, reason: null }
    : {
        value: null,
        reason: value === null ? reason : "计算结果非有限（数值溢出）",
      };
const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);
const sampleStd = (values: readonly number[]) => {
  const offsets = values.map((value) => value - values[0]!);
  const center = mean(offsets);
  return Math.sqrt(
    offsets.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      (values.length - 1),
  );
};
const daysBetween = (start: string, end: string) =>
  Math.round((Date.parse(end) - Date.parse(start)) / 86400000);

export function evaluatePerformance(
  initial: number,
  points: readonly PerformancePoint[],
  initialDate = points[0]?.date,
): PerformanceEvaluation {
  if (!Number.isFinite(initial) || initial <= 0)
    throw new Error("评价期初权益必须为正有限数");
  let previous = initial;
  let previousDate = "";
  for (const point of points) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(point.date) ||
      !Number.isFinite(Date.parse(point.date)) ||
      new Date(point.date).toISOString().slice(0, 10) !== point.date ||
      point.date <= previousDate ||
      !Number.isFinite(point.value) ||
      point.value <= 0 ||
      (point.benchmarkReturn !== undefined &&
        (!Number.isFinite(point.benchmarkReturn) ||
          point.benchmarkReturn <= -1))
    )
      throw new Error(
        "评价数据日期、权益或对照收益无效；不得缺失补零或交集拼接",
      );
    previousDate = point.date;
  }
  const returns = points.map((point) => {
    const value = point.value / previous - 1;
    previous = point.value;
    return value;
  });
  const n = points.length;
  const empty = metric(null, "没有日收盘净值");
  const annualMissing = "不足252个交易日，不展示年化收益与Calmar";
  const missingBenchmark = "缺少完整同窗持有对照";
  const differential = returns.map((r) => r - dailyRiskFree);
  const deviation = n >= 2 ? sampleStd(returns) : 0;
  const downside = Math.sqrt(
    mean(differential.map((r) => Math.min(r, 0) ** 2)),
  );
  const hasBenchmark =
    n > 0 && points.every((p) => p.benchmarkReturn !== undefined);
  const active = hasBenchmark
    ? returns.map((r, i) => r - points[i]!.benchmarkReturn!)
    : [];
  const activeStd = n >= 2 && hasBenchmark ? sampleStd(active) : 0;
  const total = n ? points.at(-1)!.value / initial - 1 : null;
  const annual = n >= yearlyDays ? (1 + total!) ** (yearlyDays / n) - 1 : null;
  const benchmark = hasBenchmark
    ? points.reduce((value, p) => value * (1 + p.benchmarkReturn!), 1) - 1
    : null;

  let peak = initial;
  let peakDate = initialDate ?? "";
  let current: DrawdownEpisode | null = null;
  const episodes: DrawdownEpisode[] = [];
  for (const point of points) {
    if (point.value >= peak) {
      if (current) {
        current.recoveryDate = point.date;
        current.recoveryDays = daysBetween(current.valleyDate, point.date);
        current.observedRecoveryDays = current.recoveryDays;
        current.underwaterDays = daysBetween(current.peakDate, point.date);
        episodes.push(current);
        current = null;
      }
      peak = point.value;
      peakDate = point.date;
      continue;
    }
    const depth = 1 - point.value / peak;
    if (!current)
      current = {
        peakDate,
        valleyDate: point.date,
        recoveryDate: null,
        depth,
        recoveryDays: null,
        observedRecoveryDays: 0,
        underwaterDays: 0,
      };
    if (depth > current.depth) {
      current.depth = depth;
      current.valleyDate = point.date;
    }
    current.observedRecoveryDays = daysBetween(current.valleyDate, point.date);
    current.underwaterDays = daysBetween(current.peakDate, point.date);
  }
  if (current) episodes.push(current);
  const worst = episodes.reduce<DrawdownEpisode | null>(
    (a, b) => (!a || b.depth > a.depth ? b : a),
    null,
  );
  const maxDrawdown = worst?.depth ?? 0;
  const recovery = worst
    ? metric(
        worst.recoveryDays,
        `未修复，已观察${worst.observedRecoveryDays}自然日（谷底起）`,
      )
    : metric(null, "无回撤，不适用");
  return {
    version: "daily-performance-v1",
    start: points[0]?.date ?? null,
    end: points.at(-1)?.date ?? null,
    initial,
    days: n,
    shortSample: n < yearlyDays,
    totalReturn: n ? metric(total) : empty,
    annualReturn: n ? metric(annual, annualMissing) : empty,
    benchmarkReturn: metric(benchmark, missingBenchmark),
    excessReturn: metric(
      total !== null && benchmark !== null ? total - benchmark : null,
      missingBenchmark,
    ),
    sharpe: metric(
      n >= 2 && deviation > 0
        ? (mean(differential) / deviation) * Math.sqrt(yearlyDays)
        : null,
      n < 2 ? "至少需要2个交易日" : "日收益零波动，夏普不可计算",
    ),
    sortino: metric(
      n && downside > 0
        ? (mean(differential) / downside) * Math.sqrt(yearlyDays)
        : null,
      "无下行偏差或没有样本，索提诺不可计算",
    ),
    informationRatio: metric(
      activeStd > 0 ? (mean(active) / activeStd) * Math.sqrt(yearlyDays) : null,
      !hasBenchmark
        ? missingBenchmark
        : n < 2
          ? "至少需要2个交易日"
          : "跟踪误差为零，信息比率不可计算",
    ),
    annualVolatility: metric(
      n >= 2 ? deviation * Math.sqrt(yearlyDays) : null,
      "至少需要2个交易日",
    ),
    trackingError: metric(
      hasBenchmark && n >= 2 ? activeStd * Math.sqrt(yearlyDays) : null,
      hasBenchmark ? "至少需要2个交易日" : missingBenchmark,
    ),
    maxDrawdown: n ? metric(maxDrawdown) : empty,
    calmar: metric(
      annual !== null && maxDrawdown > 0 ? annual / maxDrawdown : null,
      n < yearlyDays ? annualMissing : "无回撤，Calmar不可计算",
    ),
    recoveryDays: n ? recovery : empty,
    longestUnderwaterDays: n
      ? metric(Math.max(0, ...episodes.map((e) => e.underwaterDays)))
      : empty,
    maxDrawdownEpisode: worst,
  };
}

export function performancePeriods(
  initial: number,
  points: readonly PerformancePoint[],
  frequency: PerformanceFrequency,
): PerformancePeriod[] {
  // Validate the full sequence once before splitting; periods cannot hide bad input.
  evaluatePerformance(initial, points);
  const groups = new Map<
    string,
    { points: PerformancePoint[]; initial: number; initialDate: string }
  >();
  let previous = initial;
  let previousDate = points[0]?.date ?? "";
  for (const point of points) {
    const year = point.date.slice(0, 4);
    const key =
      frequency === "year"
        ? year
        : frequency === "month"
          ? point.date.slice(0, 7)
          : `${year}-Q${Math.ceil(Number(point.date.slice(5, 7)) / 3)}`;
    if (!groups.has(key))
      groups.set(key, {
        points: [],
        initial: previous,
        initialDate: previousDate,
      });
    groups.get(key)!.points.push(point);
    previous = point.value;
    previousDate = point.date;
  }
  return [...groups].map(([key, group], index) => ({
    key,
    year: Number(key.slice(0, 4)),
    boundary: index === 0 || index === groups.size - 1,
    evaluation: evaluatePerformance(
      group.initial,
      group.points,
      group.initialDate,
    ),
  }));
}
