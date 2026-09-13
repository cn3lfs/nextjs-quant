import { dailyPerformance } from "./daily-performance";
import type { ReviewValue } from "./trade-review";

const missing = (reason: string): ReviewValue => ({ value: null, reason });
const metric = (value: number): ReviewValue =>
  Number.isFinite(value)
    ? { value, reason: null }
    : missing("计算结果非有限值，数值溢出");
const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);

/** 每段独立本金；坏净值及其下一日不跨日连接。收益单位为小数。 */
export function equityDailyReturns(
  equity: readonly { value: number }[],
  initial: number,
): (number | null)[] {
  return equity.map((point, i) => {
    const previous = i === 0 ? initial : equity[i - 1]!.value;
    if (
      !Number.isFinite(previous) ||
      previous <= 0 ||
      !Number.isFinite(point.value) ||
      point.value < 0
    )
      return null;
    const value = point.value / previous - 1;
    return Number.isFinite(value) ? value : null;
  });
}

/** Φ(x) = erfc(-x/√2)/2；中心区有理近似，尾部用连分式避免相消。 */
export function normalCdf(x: number): number {
  if (Number.isNaN(x)) throw new Error("输入含非有限数");
  const y = Math.abs(x);
  if (y === 0) return 0.5;
  const tail =
    Math.exp((-y * y) / 2) *
    (y < 7.07106781186547
      ? ((((((0.0352624965998911 * y + 0.700383064443688) * y +
          6.37396220353165) *
          y +
          33.912866078383) *
          y +
          112.079291497871) *
          y +
          221.213596169931) *
          y +
          220.206867912376) /
        (((((((0.0883883476483184 * y + 1.75566716318264) * y +
          16.064177579207) *
          y +
          86.7807322029461) *
          y +
          296.564248779674) *
          y +
          637.333633378831) *
          y +
          793.826512519948) *
          y +
          440.413735824752)
      : 1 /
        (y + 1 / (y + 2 / (y + 3 / (y + 4 / (y + 0.65))))) /
        Math.sqrt(2 * Math.PI));
  return x < 0 ? tail : 1 - tail;
}

/** Acklam 逆正态 CDF 有理近似；概率端点没有有限分位数。 */
export function normalInv(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1)
    throw new Error("概率必须在 (0,1) 内");
  if (p === 0.5) return 0;
  if (p < 0.02425 || p > 0.97575) {
    const q = Math.sqrt(-2 * (p < 0.5 ? Math.log(p) : Math.log1p(-p)));
    const value =
      (((((-0.007784894002430293 * q - 0.3223964580411365) * q -
        2.400758277161838) *
        q -
        2.549732539343734) *
        q +
        4.374664141464968) *
        q +
        2.938163982698783) /
      ((((0.007784695709041462 * q + 0.3224671290700398) * q +
        2.445134137142996) *
        q +
        3.754408661907416) *
        q +
        1);
    return p < 0.5 ? value : -value;
  }
  const q = p - 0.5,
    r = q * q;
  return (
    ((((((-39.69683028665376 * r + 220.9460984245205) * r - 275.9285104469687) *
      r +
      138.357751867269) *
      r -
      30.66479806614716) *
      r +
      2.506628277459239) *
      q) /
    (((((-54.47609879822406 * r + 161.5858368580409) * r - 155.6989798598866) *
      r +
      66.80131188771972) *
      r -
      13.28068155288572) *
      r +
      1)
  );
}

function invalidReturns(
  returns: readonly (number | null)[],
): ReviewValue | null {
  if (returns.some((r) => r !== null && !Number.isFinite(r)))
    return missing("输入含非有限数");
  if (returns.some((r) => r === null))
    return missing("日收益缺失，无法进行多重检验");
  if (returns.length < 3) return missing("观测数不足");
  return null;
}

export function sharpeDaily(returns: readonly (number | null)[]): ReviewValue {
  return (
    invalidReturns(returns) ??
    dailyPerformance({ returns, basis: "simple", yearlyDays: 1 }).sharpeWbt
  );
}

function standardizedMoment(
  returns: readonly (number | null)[],
  order: number,
): ReviewValue {
  const invalid = invalidReturns(returns);
  if (invalid) return invalid;
  const values = returns as readonly number[];
  const offsets = values.map((r) => r - values[0]!);
  const center = mean(offsets);
  const deviations = offsets.map((r) => r - center);
  const deviation = Math.sqrt(mean(deviations.map((r) => r * r)));
  if (deviation === 0) return missing("日收益方差为零，标准化矩不可估");
  return metric(mean(deviations.map((r) => (r / deviation) ** order)));
}
export const skewness = (returns: readonly (number | null)[]) =>
  standardizedMoment(returns, 3);
export const kurtosis = (returns: readonly (number | null)[]) =>
  standardizedMoment(returns, 4);

export type SharpeMoments = {
  sharpe: number;
  observations: number;
  skewness: number;
  kurtosis: number;
};

/** Bailey & López de Prado (2014), Eq. (2)：SR 与门槛必须同频，峰度非超额。 */
export function probabilisticSharpe(
  input: SharpeMoments,
  benchmark = 0,
): ReviewValue {
  const { sharpe, observations, skewness, kurtosis } = input;
  if (
    ![sharpe, observations, skewness, kurtosis, benchmark].every(
      Number.isFinite,
    )
  )
    return missing("输入含非有限数");
  if (observations < 3) return missing("观测数不足");
  if (!Number.isInteger(observations)) return missing("观测数必须为整数");
  const denominator =
    1 - skewness * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2;
  if (denominator <= 0) return missing("PSR 分母非正，序列矩退化");
  const z =
    ((sharpe - benchmark) * Math.sqrt(observations - 1)) /
    Math.sqrt(denominator);
  if (!Number.isFinite(denominator) || !Number.isFinite(z))
    return missing("计算结果非有限值，数值溢出");
  return metric(normalCdf(z));
}

export function sharpeVariance(
  sharpes: readonly (number | null)[],
): ReviewValue {
  if (sharpes.some((r) => r !== null && !Number.isFinite(r)))
    return missing("输入含非有限数");
  if (sharpes.length < 2) return missing("试验次数不足，无法估计选择偏差");
  if (sharpes.some((r) => r === null))
    return missing("候选夏普缺失，无法估计试验间方差");
  const values = sharpes as readonly number[];
  const offsets = values.map((r) => r - values[0]!);
  const center = mean(offsets);
  const variance = offsets.reduce(
    (sum, r) => sum + (r - center) ** 2 / (values.length - 1),
    0,
  );
  return variance === 0
    ? missing("试验间夏普无差异，紧缩门槛退化为零")
    : metric(variance);
}

export function deflatedSharpeThreshold(
  trials: number,
  variance: number,
): ReviewValue {
  if (![trials, variance].every(Number.isFinite))
    return missing("输入含非有限数");
  if (trials < 2) return missing("试验次数不足，无法估计选择偏差");
  if (!Number.isSafeInteger(trials)) return missing("试验次数必须为安全整数");
  if (variance === 0) return missing("试验间夏普无差异，紧缩门槛退化为零");
  if (variance < 0) return missing("试验间夏普方差不能为负");
  const gamma = 0.5772156649015329;
  // 用对称分位数避免大 N 时 1 - 1/N 被舍入为 1。
  return metric(
    Math.sqrt(variance) *
      (-(1 - gamma) * normalInv(1 / trials) -
        gamma * normalInv(1 / trials / Math.E)),
  );
}

export function deflatedSharpe(
  input: SharpeMoments,
  trials: number,
  variance: number,
): ReviewValue {
  if (!Object.values(input).every(Number.isFinite))
    return missing("输入含非有限数");
  const threshold = deflatedSharpeThreshold(trials, variance);
  return threshold.value === null
    ? threshold
    : probabilisticSharpe(input, threshold.value);
}

export type MultipleTesting = {
  recordedTrials?: ReviewValue;
  trials: number;
  trialSharpes: (number | null)[];
  trialSharpeReasons: (string | null)[];
  sharpeVariance: ReviewValue;
  selected: {
    observations: number;
    sharpeDaily: ReviewValue;
    sharpeAnnual: ReviewValue;
    skewness: ReviewValue;
    kurtosis: ReviewValue;
    psr: ReviewValue;
    dsr: ReviewValue;
    threshold: ReviewValue;
  };
  yearlyDays: number;
};

export function multipleTesting(
  returns: readonly (number | null)[],
  trials: readonly ReviewValue[],
  yearlyDays = 252,
): MultipleTesting {
  if (!Number.isFinite(yearlyDays) || yearlyDays <= 0)
    throw new Error("年化天数必须为正有限数");
  const sr = sharpeDaily(returns),
    skew = skewness(returns),
    kurt = kurtosis(returns);
  const variance = sharpeVariance(trials.map((trial) => trial.value));
  const threshold =
    variance.value === null
      ? variance
      : deflatedSharpeThreshold(trials.length, variance.value);
  const moments =
    sr.value !== null && skew.value !== null && kurt.value !== null
      ? {
          sharpe: sr.value,
          observations: returns.length,
          skewness: skew.value,
          kurtosis: kurt.value,
        }
      : null;
  const unavailable = [sr, skew, kurt].find((m) => m.value === null)!;
  return {
    trials: trials.length,
    trialSharpes: trials.map((trial) => trial.value),
    trialSharpeReasons: trials.map((trial) => trial.reason),
    sharpeVariance: variance,
    yearlyDays,
    selected: {
      observations: returns.length,
      sharpeDaily: sr,
      sharpeAnnual:
        sr.value === null ? sr : metric(sr.value * Math.sqrt(yearlyDays)),
      skewness: skew,
      kurtosis: kurt,
      psr: moments ? probabilisticSharpe(moments) : unavailable,
      dsr: !moments
        ? unavailable
        : threshold.value === null
          ? threshold
          : probabilisticSharpe(moments, threshold.value),
      threshold,
    },
  };
}
