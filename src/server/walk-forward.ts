import { createHash } from "node:crypto";
import { strategySchema, type Snapshot, type Strategy } from "~/lib/domain";
import {
  walkForwardSchema,
  type WalkForwardOptions,
  type WalkForwardResult,
} from "~/lib/walk-forward";
import { backtestCostsSchema, type BacktestCosts } from "~/lib/backtest-costs";
import { backtest } from "./quant";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function walkForwardCandidates(base: Strategy): Strategy[] {
  const strategy = strategySchema.parse(base),
    result: Strategy[] = [];
  const values = (value: number, min: number, max: number) => [
    ...new Set([
      Math.max(min, Math.floor(value / 2)),
      value,
      Math.min(max, value * 2),
    ]),
  ];
  for (const fast of values(strategy.fast, 2, 120))
    for (const slow of values(strategy.slow, 3, 250))
      if (fast < slow) result.push({ ...strategy, fast, slow });
  return result;
}
export function walkForward(
  source: Snapshot,
  base: Strategy,
  initial: number,
  costInput: BacktestCosts,
  raw: WalkForwardOptions,
  onProgress?: (done: number, total: number) => void,
): WalkForwardResult {
  if (
    source.period !== "day" ||
    !/^(sh(60|68)|sz(00|30)|bj(43|83|87|88|92))\d{4}$/.test(source.symbol)
  )
    throw new Error("滚动检验当前仅支持A股日线研究模拟");
  if (!Number.isFinite(initial) || initial < 1000 || initial > 1e9)
    throw new Error("初始资金非法");
  const options = walkForwardSchema.parse(raw),
    costs = backtestCostsSchema.parse(costInput),
    candidates = walkForwardCandidates(base);
  const warmupBars = Math.max(...candidates.map((s) => s.slow)) + 2;
  const { bars } = source;
  if (
    source.historicalAsOf &&
    bars.some((b) => b.date.slice(0, 10) > source.historicalAsOf!)
  )
    throw new Error("行情超出历史截止日期");
  if (bars.some((b, i) => i > 0 && b.date <= bars[i - 1]!.date))
    throw new Error("行情日期必须严格递增");
  const count = Math.floor(
    (bars.length - warmupBars - options.trainBars) / options.testBars,
  );
  if (count < 1)
    throw new Error(
      `至少需要 ${warmupBars + options.trainBars + options.testBars} 根日线（含预热、训练与测试）`,
    );
  const folds: WalkForwardResult["folds"] = [];
  for (let fold = 0; fold < count; fold++) {
    const trainStart = warmupBars + fold * options.testBars,
      testStart = trainStart + options.trainBars,
      testEnd = testStart + options.testBars;
    const trainingBars = bars.slice(trainStart - warmupBars, testStart);
    const training = candidates
      .map((strategy) => {
        const result = backtest(
          trainingBars,
          strategy,
          source.id,
          initial,
          costs,
          warmupBars,
        );
        return {
          strategy,
          totalReturn: result.totalReturn,
          maxDrawdown: result.maxDrawdown,
          trades: result.trades.length,
        };
      })
      .sort(
        (a, b) =>
          b.totalReturn - a.totalReturn ||
          a.maxDrawdown - b.maxDrawdown ||
          a.strategy.fast - b.strategy.fast ||
          a.strategy.slow - b.strategy.slow,
      );
    const selected = training[0]!.strategy;
    const testBars = bars.slice(testStart - warmupBars, testEnd);
    const test = backtest(
      testBars,
      selected,
      source.id,
      initial,
      costs,
      warmupBars,
    );
    folds.push({
      trainStart: bars[trainStart]!.date,
      trainEnd: bars[testStart - 1]!.date,
      testStart: bars[testStart]!.date,
      testEnd: bars[testEnd - 1]!.date,
      trainHash: hash(trainingBars),
      testHash: hash(testBars),
      selected,
      training,
      test,
      benchmarkReturn:
        (bars[testEnd - 1]!.close / bars[testStart]!.open - 1) * 100,
    });
    onProgress?.(fold + 1, count);
  }
  const returns = folds.map((f) => f.test.totalReturn).sort((a, b) => a - b);
  return {
    version: "walk-forward-1",
    symbol: source.symbol,
    snapshotId: source.id,
    sourceHash: source.hash,
    initial,
    baseStrategy: strategySchema.parse(base),
    options,
    candidates,
    warmupBars,
    unusedTailBars:
      bars.length - warmupBars - options.trainBars - count * options.testBars,
    folds,
    summary: {
      folds: count,
      positiveFolds: returns.filter((r) => r > 0).length,
      averageReturn: returns.reduce((a, b) => a + b, 0) / count,
      medianReturn:
        count % 2
          ? returns[Math.floor(count / 2)]!
          : (returns[count / 2 - 1]! + returns[count / 2]!) / 2,
      worstReturn: returns[0]!,
      worstDrawdown: Math.max(...folds.map((f) => f.test.maxDrawdown)),
      averageBenchmarkReturn:
        folds.reduce((sum, f) => sum + f.benchmarkReturn, 0) / count,
    },
    assumptions: [
      "研究模拟：固定长度训练窗口逐轮前移，测试段不重叠；仅完整测试段纳入统计。",
      "均线候选为当前参数的半值/原值/双值（按支持边界截断）；其他筛选条件固定。训练净收益最高者入选，并列按回撤、短均线、长均线排序。",
      "所有候选训练评估区间一致；预热行情只计算指标。每轮测试以独立初始资金和零持仓开始，训练持仓不带入。",
      "各轮期末持仓按收盘估值；平均收益为独立测试段算术均值，不是连续账户收益或年化收益。",
      "价格涨幅为同一证券测试首根开盘到末根收盘的变化，未扣费用且不考虑整手或成交约束；另存同资金同成本买入持有模拟，策略超额仅指与该模拟的收益百分点差。两者均非市场指数。",
      "训练样本可能包含前轮测试数据，但每轮选参严格不使用本轮及以后测试行情。人工反复修改参数仍可能对整个历史过拟合。",
      ...folds[0]!.test.assumptions,
    ],
  };
}
