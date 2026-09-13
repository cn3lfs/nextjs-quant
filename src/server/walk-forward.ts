import { combinatoriallySymmetricCv } from "~/lib/backtest-overfit";
import { createHash } from "node:crypto";
import { strategySchema, type Snapshot, type Strategy } from "~/lib/domain";
import {
  walkForwardSchema,
  type WalkForwardOptions,
  type WalkForwardResult,
} from "~/lib/walk-forward";
import { backtestCostsSchema, type BacktestCosts } from "~/lib/backtest-costs";
import { backtest } from "./quant";
import {
  equityDailyReturns,
  multipleTesting,
  sharpeDaily,
} from "~/lib/multiple-testing";
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

export function candidateTrialMatrix(
  source: Snapshot,
  base: Strategy,
  initial: number,
  costInput: BacktestCosts,
  raw: WalkForwardOptions,
) {
  walkForwardSchema.parse(raw);
  if (
    source.period !== "day" ||
    !/^(sh(60|68)|sz(00|30)|bj(43|83|87|88|92))\d{4}$/.test(source.symbol)
  )
    throw new Error("滚动检验当前仅支持A股日线研究模拟");
  if (!Number.isFinite(initial) || initial < 1000 || initial > 1e9)
    throw new Error("初始资金非法");
  if (
    source.historicalAsOf &&
    source.bars.some((b) => b.date.slice(0, 10) > source.historicalAsOf!)
  )
    throw new Error("行情超出历史截止日期");
  if (source.bars.some((b, i) => i > 0 && b.date <= source.bars[i - 1]!.date))
    throw new Error("行情日期必须严格递增");
  const candidates = walkForwardCandidates(base);
  const warmupBars = Math.max(...candidates.map((s) => s.slow)) + 2;
  const costs = backtestCostsSchema.parse(costInput);
  const returns = candidates.map((strategy) =>
    equityDailyReturns(
      backtest(source.bars, strategy, source.id, initial, costs, warmupBars)
        .equity,
      initial,
    ),
  );
  const statistics = returns.map(sharpeDaily);
  return {
    candidates,
    returns,
    sharpes: statistics.map((s) => s.value),
    sharpeReasons: statistics.map((s) => s.reason),
    dates: source.bars.slice(warmupBars).map((b) => b.date),
  };
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
  const matrix = candidateTrialMatrix(source, base, initial, costs, options);
  const testing = multipleTesting(
    folds.flatMap((fold) => equityDailyReturns(fold.test.equity, initial)),
    matrix.sharpes.map((value, i) => ({
      value,
      reason: matrix.sharpeReasons[i]!,
    })),
    options.yearlyDays ?? 252,
  );
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
    multipleTesting: {
      ...testing,
      overfit: combinatoriallySymmetricCv({ returns: matrix.returns }),
    },
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
      "Bailey、Borwein、López de Prado 与 Zhu（2015）：PBO 按同频夏普选择训练最优者，训练并列取候选小序号、样本外并列取平均排名；不同于滚动检验的净收益/回撤/均线排序，不是对原选参规则的等价验证。",
      "PBO 仅限当前均线半值/原值/双值候选集合；换集合结果会变，未记录的人工试验不可观测。矩阵复用全窗连续模拟日收益，子段不重置持仓，不代表独立重跑或策略有效，不构成业绩证据。",
      ...folds[0]!.test.assumptions,
      "Bailey & López de Prado（2014）：试验次数 N = 本次候选数，是实际试验数的下界；人工反复调整参数、更换标的、改窗口的次数不可观测，不计入 N，因此 DSR 是乐观估计，不构成业绩证据。",
      "V[SR] 由预热后同一完整区间上 N 个候选的日夏普样本方差（ddof=1）估计，包含未满 fold 的尾部；候选高度相关时方差估计可能偏小、DSR 偏乐观。未估计论文所需的有效独立试验数，相关性的总体影响不保证方向。",
      "PSR/DSR 检验各 fold 测试段日收益按时间顺序的拼接；每段按独立初始资金差分，跨 fold 换参数，不平滑、不跨 fold 复利归一，不是一个连续账户的收益。",
    ],
  };
}
