import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { combinatoriallySymmetricCv } from "~/lib/backtest/backtest-overfit";
import { curvePerformance, sharpeWbt } from "~/lib/backtest/daily-performance";
import {
  effectiveMultipleTesting,
  sharpeDaily,
  sharpeVariance,
} from "~/lib/backtest/multiple-testing";
import {
  maxParameterGridCells,
  parameterGridWarning,
  type StudioParameterGridResult,
} from "~/lib/research/studio-result";
import { clusterOosTrials } from "../validation-method";

export { maxParameterGridCells, parameterGridWarning };
export type { StudioParameterGridResult };

export type ParameterGridAxis = { key: string; values: readonly number[] };
export type ParameterGridInput = {
  xAxis: ParameterGridAxis;
  yAxis: ParameterGridAxis;
  /** Ordered observed trading dates. Stop at the first date in the holdout. */
  dates: readonly string[];
  holdoutStart: string;
  trainBars: number;
  testBars: number;
};
type GridWindow = {
  trainStart: string;
  trainEnd: string;
  start: string;
  end: string;
};
export type ParameterGridEvaluator = (request: {
  x: number;
  y: number;
  window: Readonly<GridWindow>;
  /** Exactly the independently capitalized OOS sessions to return. */
  dates: readonly string[];
}) => GridSeries | Promise<GridSeries>;
type GridSeries = {
  /** Closed position cycles in this independently capitalized test window. */
  trades: number;
  dates: readonly string[];
  returns: readonly (number | null)[];
};
export type ParameterGridCell = StudioParameterGridResult["cells"][number];

function validateGrid(input: ParameterGridInput) {
  const { xAxis, yAxis } = input;
  if (
    !xAxis.key.trim() ||
    !yAxis.key.trim() ||
    xAxis.key === yAxis.key ||
    [xAxis, yAxis].some(
      ({ values }) =>
        !values.length ||
        new Set(values).size !== values.length ||
        Array.from(values).some((v) => !Number.isFinite(v)),
    ) ||
    xAxis.values.length * yAxis.values.length > maxParameterGridCells
  )
    throw new Error(
      "网格需要两个不同参数轴、各轴唯一的有限值，且最多 36 个组合",
    );
  researchDateSchema.parse(input.holdoutStart);
  if (
    ![input.trainBars, input.testBars].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new Error("训练窗与测试窗必须为正整数");
}

/** Fixed parameters in every fold. Training history is available for warmup
 * only. The evaluator never receives a holdout range or an incomplete fold. */
export async function computeParameterGrid(
  input: ParameterGridInput,
  evaluate: ParameterGridEvaluator,
  signal?: AbortSignal,
): Promise<StudioParameterGridResult> {
  signal?.throwIfAborted();
  validateGrid(input);
  const { xAxis, yAxis, holdoutStart, trainBars, testBars } = input;
  const dev: string[] = [];
  for (const date of input.dates) {
    if (date >= holdoutStart) break;
    if (
      !researchDateSchema.safeParse(date).success ||
      (dev.length && date <= dev.at(-1)!)
    )
      throw new Error("开发段交易日历无效、重复或倒序");
    dev.push(date);
  }
  const folds = [];
  for (let i = trainBars; i + testBars <= dev.length; i += testBars) {
    folds.push({
      window: Object.freeze({
        trainStart: dev[i - trainBars]!,
        trainEnd: dev[i - 1]!,
        start: dev[i]!,
        end: dev[i + testBars - 1]!,
      }),
      dates: Object.freeze(dev.slice(i, i + testBars)),
    });
  }
  const dates = folds.flatMap((fold) => fold.dates);
  // The summary DSR refers to the first declared cell, fixed before replay.
  const reference = { x: xAxis.values[0]!, y: yAxis.values[0]! };
  const result: StudioParameterGridResult = {
    status: "insufficient",
    warning: parameterGridWarning,
    xAxis: { ...xAxis, values: [...xAxis.values] },
    yAxis: { ...yAxis, values: [...yAxis.values] },
    holdoutStart,
    windows: folds.map((fold) => fold.window),
    devOosDays: dates.length,
    trailingDevelopmentDays: Math.max(0, dev.length - trainBars - dates.length),
    cells: [],
    pboMetric: "sharpe",
    pbo: null,
    dsrReference: reference,
    dsr: null,
    dsrThreshold: 0.95,
    effectiveTrials: null,
    distinctReturnSeries: null,
    cscvCombinations: null,
    discardedCscvDays: null,
    reason: null,
  };
  const trials: { id: string; dates: string[]; returns: number[] }[] = [];
  const uniqueSeries = new Set<string>();
  for (const x of xAxis.values) {
    for (const y of yAxis.values) {
      const cell: ParameterGridCell = {
        trades: null,
        x,
        y,
        totalReturn: null,
        maxDrawdown: null,
        sharpe: null,
        dsr: null,
        meetsDsrThreshold: null,
        reason: null,
      };
      result.cells.push(cell);
      try {
        if (!folds.length) throw new Error("开发段不足一个完整滚动测试窗");
        const returns: number[] = [];
        let trades = 0;
        for (const fold of folds) {
          signal?.throwIfAborted();
          const sample = await evaluate({ x, y, ...fold });
          if (!Number.isSafeInteger(sample.trades) || sample.trades < 0)
            throw new Error("OOS 已平仓回合数无效");
          trades += sample.trades;
          if (
            sample.dates.length !== fold.dates.length ||
            sample.returns.length !== fold.dates.length
          )
            throw new Error("OOS 日期或收益条数与共同交易日轴不符");
          for (const [i, date] of fold.dates.entries()) {
            const r = sample.returns[i];
            if (
              sample.dates[i] !== date ||
              typeof r !== "number" ||
              !Number.isFinite(r) ||
              r < -1
            )
              throw new Error(`OOS 日期错位或收益无效：${date}`);
            returns.push(r);
          }
        }
        const curve = curvePerformance(returns);
        const sharpe = sharpeWbt(returns, 252);
        cell.totalReturn = curve.totalReturn.value;
        cell.trades = trades;
        cell.maxDrawdown = curve.maxDrawdown.value;
        cell.sharpe = sharpe.value;
        cell.reason =
          curve.totalReturn.reason ?? curve.maxDrawdown.reason ?? sharpe.reason;
        if (cell.reason) continue;
        // CSCV ranks every declared candidate, including tied paths. Only
        // the clustering step estimates the independent trial count.
        uniqueSeries.add(JSON.stringify(returns));
        trials.push({ id: JSON.stringify([x, y]), dates, returns });
      } catch (error) {
        signal?.throwIfAborted();
        cell.reason =
          error instanceof Error
            ? error.message || "滚动回放失败"
            : "滚动回放失败";
      }
    }
  }
  signal?.throwIfAborted();
  result.reason =
    result.cells.find((cell) => cell.reason !== null)?.reason ?? null;
  if (result.reason) return result;
  const cluster = clusterOosTrials(trials, 0.95);
  const cscv = combinatoriallySymmetricCv({
    returns: trials.map((trial) => trial.returns),
    metric: "sharpe",
    splits: 10,
  });
  if (cluster.effectiveTrials === null || cscv.pbo.value === null) {
    result.reason = cluster.reason ?? cscv.pbo.reason;
    return result;
  }
  const effectiveTrials = cluster.effectiveTrials;
  const sharpes = trials.map((trial) => sharpeDaily(trial.returns));
  const variance = sharpeVariance(sharpes.map((sharpe) => sharpe.value));
  if (variance.value === null) {
    result.reason = variance.reason;
    return result;
  }
  const scores = trials.map(
    (trial) =>
      effectiveMultipleTesting(trial.returns, sharpes, effectiveTrials, 252)
        .selected.dsr,
  );
  const missing = scores.find((score) => score.value === null);
  if (missing) {
    result.reason = missing.reason;
    return result;
  }
  for (const [i, cell] of result.cells.entries()) {
    cell.dsr = scores[i]!.value!;
    cell.meetsDsrThreshold = cell.dsr >= result.dsrThreshold;
  }
  return {
    ...result,
    status: "reviewed",
    pbo: cscv.pbo.value,
    dsr: result.cells[0]!.dsr,
    effectiveTrials,
    distinctReturnSeries: uniqueSeries.size,
    cscvCombinations: cscv.combinations,
    discardedCscvDays: cscv.discardedPeriods,
  };
}
