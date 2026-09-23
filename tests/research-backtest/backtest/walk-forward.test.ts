import { expect, it } from "vitest";
import {
  walkForward,
  walkForwardCandidates,
} from "../../../src/server/backtest/walk-forward";
import { defaultStrategy, type Snapshot } from "../../../src/lib/domain";
import { defaultBacktestCosts } from "../../../src/lib/backtest/backtest-costs";
import { backtest } from "../../../src/server/backtest/quant";
const strategy = { ...defaultStrategy, fast: 4, slow: 12 };
const source: Snapshot = {
  id: "wf-fixture",
  symbol: "sh600000",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture-hash",
  bars: Array.from({ length: 240 }, (_, i) => {
    const close = 100 + 10 * Math.sin(i / 9) + i * 0.02;
    return {
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      close,
      high: close + 1,
      low: close - 1,
      volume: 100000,
      amount: close * 100000,
    };
  }),
};
const options = { trainBars: 60, testBars: 20 };
it("测试段不重叠且无预热成交，每轮独立现金并保留全部候选与费用", () => {
  const result = walkForward(
    source,
    strategy,
    100000,
    defaultBacktestCosts,
    options,
  );
  expect(result.folds).toHaveLength(7);
  expect(result.unusedTailBars).toBe(14);
  expect(result.folds[0]!.trainStart).toBe(source.bars[26]!.date);
  expect(result.folds[0]!.testStart).toBe(source.bars[86]!.date);
  expect(result.folds.some((f) => f.test.trades.length > 0)).toBe(true);
  for (const [i, fold] of result.folds.entries()) {
    expect(fold.trainEnd < fold.testStart).toBe(true);
    if (i) expect(result.folds[i - 1]!.testEnd < fold.testStart).toBe(true);
    expect(fold.test.equity).toHaveLength(20);
    expect(
      fold.test.trades.every(
        (t) => t.date >= fold.testStart && t.date <= fold.testEnd,
      ),
    ).toBe(true);
    expect(fold.test.diagnostics.initial).toBe(100000);
    expect(fold.training).toHaveLength(result.candidates.length);
    expect(fold.test.costs).toEqual(defaultBacktestCosts);
    expect(fold.trainHash).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(
    new Set(result.folds.flatMap((f) => f.test.equity.map((e) => e.date))).size,
  ).toBe(140);
  expect(result.summary.averageReturn).toBeCloseTo(
    result.folds.reduce((sum, f) => sum + f.test.totalReturn, 0) / 7,
  );
});
it("修改本轮及以后行情不会改变本轮训练排名或入选参数", () => {
  const original = walkForward(
    source,
    strategy,
    100000,
    defaultBacktestCosts,
    options,
  );
  const boundary = original.warmupBars + options.trainBars;
  const future = {
    ...source,
    bars: source.bars.map((bar, i) =>
      i < boundary
        ? bar
        : {
            ...bar,
            open: bar.open * 2,
            close: bar.close * 2,
            high: bar.high * 2,
            low: bar.low * 2,
          },
    ),
  };
  const changed = walkForward(
    future,
    strategy,
    100000,
    defaultBacktestCosts,
    options,
  );
  expect(changed.folds[0]!.training).toEqual(original.folds[0]!.training);
  expect(changed.folds[0]!.selected).toEqual(original.folds[0]!.selected);
  expect(changed.folds[0]!.trainHash).toBe(original.folds[0]!.trainHash);
  expect(changed.folds[0]!.testHash).not.toBe(original.folds[0]!.testHash);
});
it("候选合法去重，拒绝不足数据、分钟线及越过历史截止", () => {
  const grid = walkForwardCandidates({ ...strategy, fast: 2, slow: 3 });
  expect(grid.every((s) => s.fast >= 2 && s.fast < s.slow)).toBe(true);
  expect(new Set(grid.map((s) => `${s.fast}/${s.slow}`)).size).toBe(
    grid.length,
  );
  expect(() =>
    walkForward(
      { ...source, bars: source.bars.slice(0, 100) },
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    ),
  ).toThrow("至少需要");
  expect(() =>
    walkForward(
      { ...source, period: "5m" },
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    ),
  ).toThrow("日线");
  expect(() =>
    walkForward(
      { ...source, historicalAsOf: "2025-02-01" },
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    ),
  ).toThrow("截止");
  expect(() =>
    backtest(source.bars, strategy, source.id, 100000, defaultBacktestCosts, 2),
  ).toThrow("预热");
});
it("V1 接入前 summary 数值特征化护栏", () => {
  // S1 (Big.js money math) recaptured these four fields: src/server/backtest/quant.ts
  // cash/fee arithmetic now runs through src/lib/money.ts instead of plain
  // double +=/-=. Deltas are all at float-epsilon scale from removing
  // accumulated dust across this fold's trade sequence, not a logic change:
  //   averageReturn   6.544974497455101  -> 6.544974497455098  (delta 3e-15)
  //   medianReturn    4.566050066345806  -> 4.566050066345784  (delta 2.2e-14)
  //   worstReturn    -0.21876888198689715 -> -0.21876888198687494 (delta 2.2e-14)
  //   worstDrawdown   0.3946594912975181 -> 0.3946594912975036  (delta 1.45e-14)
  expect(
    walkForward(source, strategy, 100000, defaultBacktestCosts, options)
      .summary,
  ).toEqual({
    folds: 7,
    positiveFolds: 5,
    averageReturn: 6.544974497455098,
    medianReturn: 4.566050066345784,
    worstReturn: -0.21876888198687494,
    worstDrawdown: 0.3946594912975036,
    averageBenchmarkReturn: 1.2507214207768094,
  });
});
