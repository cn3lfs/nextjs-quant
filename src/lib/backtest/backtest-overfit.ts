import { dailyPerformance } from "./daily-performance";
import type { Strategy } from "../domain";
import { sharpeDaily } from "./multiple-testing";
import type { ReviewValue } from "../portfolio/trade-review";

const missing = (reason: string): ReviewValue => ({ value: null, reason });
const value = (n: number): ReviewValue =>
  Number.isFinite(n)
    ? { value: n, reason: null }
    : missing("计算结果非有限值，数值溢出");
export type PerformanceDegradation = {
  slope: ReviewValue;
  intercept: ReviewValue;
  r2: ReviewValue;
};
export type BacktestOverfit = {
  splits: number;
  requestedSplits: number;
  periodLength: number;
  combinations: number;
  discardedPeriods: number;
  nullPeriods: number;
  oddPeriods: number;
  pbo: ReviewValue;
  performanceDegradation: PerformanceDegradation;
  probabilityOfLoss: ReviewValue;
  lambdas: number[];
};
export type BacktestOverfitSummary = Omit<BacktestOverfit, "lambdas">;
export type BacktestOverfitPair = {
  bySelectionRule: BacktestOverfit;
  bySharpe: BacktestOverfit;
};
export type BacktestOverfitPairSummary = {
  bySelectionRule: BacktestOverfitSummary;
  bySharpe: BacktestOverfitSummary;
};

/** V2b：复用 U1 的复利净收益与含本金回撤，均为小数比例。 */
export function selectionPerformance(returns: readonly (number | null)[]) {
  const { totalReturn, maxDrawdown } = dailyPerformance({ returns });
  return { totalReturn, maxDrawdown };
}

/** 含截距 OLS；常数因变量的 R² 无定义，不能填成 1。 */
export function performanceDegradation(
  points: readonly { train: number; test: number }[],
): PerformanceDegradation {
  const unavailable = (reason: string) => ({
    slope: missing(reason),
    intercept: missing(reason),
    r2: missing(reason),
  });
  if (points.some((p) => !Number.isFinite(p.train) || !Number.isFinite(p.test)))
    return unavailable("输入含非有限数");
  if (points.length < 2) return unavailable("回归观测数不足");
  const x = points.reduce((s, p) => s + p.train / points.length, 0);
  const y = points.reduce((s, p) => s + p.test / points.length, 0);
  const xx = points.reduce((s, p) => s + (p.train - x) ** 2, 0);
  const yy = points.reduce((s, p) => s + (p.test - y) ** 2, 0);
  const xy = points.reduce((s, p) => s + (p.train - x) * (p.test - y), 0);
  if (![x, y, xx, yy, xy].every(Number.isFinite))
    return unavailable("计算结果非有限值，数值溢出");
  if (xx === 0) return unavailable("训练绩效方差为零，无法回归");
  const slope = xy / xx;
  return {
    slope: value(slope),
    intercept: value(y - slope * x),
    r2:
      yy === 0
        ? missing("样本外绩效方差为零，R² 无定义")
        : value((xy / xx) * (xy / yy)),
  };
}

/** Bailey et al. (2015) §2.2：每个补集也作为独立的训练组合枚举。 */
export function* cscvCombinations(
  splits: number,
): Generator<{ train: number[]; test: number[] }> {
  if (!Number.isSafeInteger(splits) || splits < 4 || splits % 2)
    throw new Error("子段数必须是不小于 4 的偶数");
  const train = Array.from({ length: splits / 2 }, (_, i) => i);
  while (true) {
    const selected = new Set(train);
    yield {
      train: [...train],
      test: Array.from({ length: splits }, (_, i) => i).filter(
        (i) => !selected.has(i),
      ),
    };
    let i = train.length - 1;
    while (i >= 0 && train[i] === splits - train.length + i) i--;
    if (i < 0) return;
    train[i] = train[i]! + 1;
    for (let j = i + 1; j < train.length; j++) train[j] = train[j - 1]! + 1;
  }
}

/** docs/invariants.md V2：整段共同剔除，不删候选，不以部分组合估计 PBO。 */
export function combinatoriallySymmetricCv({
  returns,
  splits = 10,
  metric = "selection",
  candidates,
}: {
  returns: readonly (readonly (number | null)[])[];
  splits?: number;
  metric?:
    | "selection"
    | "sharpe"
    | ((returns: readonly (number | null)[]) => ReviewValue);
  candidates?: readonly Strategy[];
}): BacktestOverfit {
  const result: BacktestOverfit = {
    splits: 0,
    requestedSplits: splits,
    periodLength: 0,
    combinations: 0,
    discardedPeriods: 0,
    nullPeriods: 0,
    oddPeriods: 0,
    pbo: missing("尚未计算"),
    probabilityOfLoss: missing("尚未计算"),
    performanceDegradation: performanceDegradation([]),
    lambdas: [],
  };
  const unavailable = (reason: string): BacktestOverfit => ({
    ...result,
    lambdas: [],
    pbo: missing(reason),
    probabilityOfLoss: missing(reason),
    performanceDegradation: {
      slope: missing(reason),
      intercept: missing(reason),
      r2: missing(reason),
    },
  });
  if (
    !Number.isFinite(splits) ||
    returns.some((row) => row.some((r) => r !== null && !Number.isFinite(r)))
  )
    return unavailable("输入含非有限数");
  if (returns.length < 2) return unavailable("候选不足，无法排名");
  if (!Number.isSafeInteger(splits) || splits < 4 || splits % 2)
    return unavailable("子段数必须是不小于 4 的偶数");
  if (
    metric === "selection" &&
    (!candidates ||
      candidates.length !== returns.length ||
      candidates.some(
        (c) => !Number.isFinite(c.fast) || !Number.isFinite(c.slow),
      ))
  )
    return unavailable(
      "候选参数必须与收益矩阵逐行对应且长度一致，fast/slow 必须有限",
    );
  const length = returns[0]!.length;
  if (returns.some((row) => row.length !== length))
    return unavailable("候选日收益长度不一致，无法同期排名");
  const size = Math.floor(length / splits);
  result.periodLength = size;
  result.discardedPeriods = length % splits;
  const periods = Array.from({ length: splits }, (_, i) => i).filter((i) => {
    const invalid = returns.some((row) =>
      row.slice(i * size, (i + 1) * size).some((r) => r === null),
    );
    if (invalid) result.nullPeriods += size;
    return !invalid;
  });
  if (periods.length % 2) {
    periods.pop();
    result.oddPeriods = size;
  }
  result.discardedPeriods += result.nullPeriods + result.oddPeriods;
  result.splits = periods.length;
  if (size < 20) return unavailable("每个子段少于 20 个观测，排名不稳定");
  if (periods.length < 4) return unavailable("剔除缺失子段后不足 4 个有效子段");
  const points: { train: number; test: number }[] = [];
  let losses = 0;
  for (const combination of cscvCombinations(periods.length)) {
    const evaluate = (indices: number[]) =>
      returns.map((row) => {
        const sample = indices.flatMap((i) => {
          const start = periods[i]! * size;
          return row.slice(start, start + size);
        });
        if (metric === "selection") {
          const { totalReturn, maxDrawdown } = selectionPerformance(sample);
          return { score: totalReturn, drawdown: maxDrawdown };
        }
        return {
          score: (metric === "sharpe" ? sharpeDaily : metric)(sample),
          drawdown: value(0),
        };
      });
    const train = evaluate(combination.train),
      test = evaluate(combination.test);
    const invalid = [...train, ...test]
      .flatMap((m) => [m.score, m.drawdown])
      .find((m) => m.value === null || !Number.isFinite(m.value));
    if (invalid)
      return unavailable(invalid.reason ?? "候选绩效非有限，无法排名");
    const training = train.map((m) => m.score.value!),
      testing = test.map((m) => m.score.value!);
    const compare = (a: number, b: number) =>
      training[b]! - training[a]! ||
      (metric === "selection"
        ? train[a]!.drawdown.value! - train[b]!.drawdown.value! ||
          candidates![a]!.fast - candidates![b]!.fast ||
          candidates![a]!.slow - candidates![b]!.slow
        : 0);
    // V2b：主指标相同仍可按回撤/参数区分；完整排序也相同才整份留空。
    if (training.every((_, i) => compare(i, 0) === 0))
      return unavailable("训练集无法区分候选");
    let best = 0;
    for (let i = 1; i < training.length; i++)
      if (compare(i, best) < 0) best = i;
    const selected = testing[best]!;
    const less = testing.filter((n) => n < selected).length;
    const equal = testing.filter((n) => n === selected).length;
    const omega = (less + (equal + 1) / 2) / (returns.length + 1);
    result.lambdas.push(Math.log(omega / (1 - omega)));
    points.push({ train: training[best]!, test: selected });
    if (selected < 0) losses++;
  }
  result.combinations = result.lambdas.length;
  result.pbo = value(
    result.lambdas.filter((n) => n <= 0).length / result.combinations,
  );
  result.probabilityOfLoss = value(losses / result.combinations);
  result.performanceDegradation = performanceDegradation(points);
  return result;
}
