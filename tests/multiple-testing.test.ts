import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dailyPerformance } from "../src/lib/daily-performance";
import {
  deflatedSharpe,
  deflatedSharpeThreshold,
  equityDailyReturns,
  kurtosis,
  multipleTesting,
  normalCdf,
  normalInv,
  probabilisticSharpe,
  sharpeDaily,
  sharpeVariance,
  skewness,
} from "../src/lib/multiple-testing";
import {
  candidateTrialMatrix,
  walkForward,
  walkForwardCandidates,
} from "../src/server/walk-forward";
import { backtest } from "../src/server/quant";
import { defaultStrategy, type Snapshot } from "../src/lib/domain";
import { defaultBacktestCosts } from "../src/lib/backtest-costs";
import { MultipleTestingPanel } from "../src/components/multiple-testing-panel";

const moments = { sharpe: 0.1, observations: 101, skewness: 0, kurtosis: 3 };
const returns = [-0.02, 0.01, 0.03, -0.01, 0.005, 0.02];
const strategy = { ...defaultStrategy, fast: 4, slow: 12 };
const options = { trainBars: 60, testBars: 20 };
const source: Snapshot = {
  id: "v1-fixture",
  symbol: "sh600000",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 0,
  hash: "v1-fixture",
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

describe("正态分布与论文手算", () => {
  it.each([
    [0, 0.5],
    [1, 0.8413447460685429],
    [1.96, 0.9750021048517795],
    [-1, 0.15865525393145707],
    [3, 0.9986501019683699],
    [-8, 6.220960574271784e-16],
  ])("Φ(%s)", (x, expected) => {
    expect(normalCdf(x)).toBeCloseTo(expected, 12);
  });
  it.each([
    [0.975, 1.959963984540054],
    [0.5, 0],
    [0.001, -3.090232306167813],
    [0.999, 3.090232306167813],
  ])("逆 CDF(%s)", (p, expected) => {
    expect(normalInv(p)).toBeCloseTo(expected, 6);
    expect(normalCdf(normalInv(p))).toBeCloseTo(p, 8);
  });
  it.each([0, 1, -1, 2, NaN, Infinity])("拒绝非法概率 %s", (p) =>
    expect(() => normalInv(p)).toThrow(),
  );
  it("PSR 手算精确到 1e-9，阈值同频", () => {
    // SR=0.2, n=26, skew=0, kurt=1: z=(0.2-0)*sqrt(25)/sqrt(1)=1。
    expect(
      probabilisticSharpe({
        sharpe: 0.2,
        observations: 26,
        skewness: 0,
        kurtosis: 1,
      }).value,
    ).toBeCloseTo(0.8413447460685429, 9);
    expect(probabilisticSharpe(moments, 0.1).value).toBe(0.5);
  });
  it("固定序列与试验方差，N 增长严格降低 DSR", () => {
    const input = {
      sharpe: sharpeDaily(returns).value!,
      observations: returns.length,
      skewness: skewness(returns).value!,
      kurtosis: kurtosis(returns).value!,
    };
    const dsrs = [2, 10, 100].map((n) => deflatedSharpe(input, n, 0.02).value!);
    expect(dsrs[0]).toBeGreaterThan(dsrs[1]!);
    expect(dsrs[1]).toBeGreaterThan(dsrs[2]!);
  });
  it("负偏高峰序列比同 SR 正态基线受更大惩罚", () => {
    const r = [...Array<number>(19).fill(0.02), -0.2];
    const input = {
      sharpe: sharpeDaily(r).value!,
      observations: r.length,
      skewness: skewness(r).value!,
      kurtosis: kurtosis(r).value!,
    };
    expect(input.skewness).toBeLessThan(0);
    expect(input.kurtosis).toBeGreaterThan(3);
    expect(probabilisticSharpe(input).value!).toBeLessThan(
      probabilisticSharpe({ ...input, skewness: 0, kurtosis: 3 }).value!,
    );
  });
  it("日夏普同源 U1，三四阶矩 ddof=0，方差 ddof=1", () => {
    expect(sharpeDaily(returns).value! * Math.sqrt(252)).toBeCloseTo(
      dailyPerformance({ returns }).sharpeWbt.value!,
      12,
    );
    // [-1,0,1] 均值=0，方差=2/3，四阶矩=(2/3)/(2/3)^2=1.5。
    expect(skewness([-1, 0, 1]).value).toBe(0);
    expect(kurtosis([-1, 0, 1]).value).toBeCloseTo(1.5, 12);
    expect(sharpeVariance([1, 2, 3])).toEqual({ value: 1, reason: null });
  });
});

describe("退化必须留空并保留原因", () => {
  it("N<2", () =>
    expect(deflatedSharpe(moments, 1, 1)).toEqual({
      value: null,
      reason: "试验次数不足，无法估计选择偏差",
    }));
  it("试验方差为零", () => {
    const expected = {
      value: null,
      reason: "试验间夏普无差异，紧缩门槛退化为零",
    };
    expect(deflatedSharpe(moments, 5, 0)).toEqual(expected);
    expect(sharpeVariance([0.1, 0.1, 0.1])).toEqual(expected);
  });
  it("n<3", () => {
    expect(probabilisticSharpe({ ...moments, observations: 2 })).toEqual({
      value: null,
      reason: "观测数不足",
    });
    for (const fn of [sharpeDaily, skewness, kurtosis])
      expect(fn([1, 2])).toEqual({ value: null, reason: "观测数不足" });
  });
  it("PSR 非正分母", () =>
    expect(
      probabilisticSharpe({ ...moments, sharpe: 1, skewness: 2, kurtosis: 1 }),
    ).toEqual({ value: null, reason: "PSR 分母非正，序列矩退化" }));
  it("任一非有限输入", () => {
    for (const fn of [sharpeDaily, skewness, kurtosis, sharpeVariance])
      expect(fn([0, NaN, 1])).toEqual({
        value: null,
        reason: "输入含非有限数",
      });
    for (const key of [
      "sharpe",
      "observations",
      "skewness",
      "kurtosis",
    ] as const)
      expect(deflatedSharpe({ ...moments, [key]: Infinity }, 10, 1)).toEqual({
        value: null,
        reason: "输入含非有限数",
      });
    expect(deflatedSharpeThreshold(Infinity, 1).reason).toBe("输入含非有限数");
    expect(deflatedSharpeThreshold(10, NaN).reason).toBe("输入含非有限数");
    expect(probabilisticSharpe(moments, NaN).reason).toBe("输入含非有限数");
  });
  it("常数、缺失、溢出、负方差、非法计数不能伪造统计", () => {
    for (const fn of [sharpeDaily, skewness, kurtosis]) {
      expect(fn([0, 0, 0]).value).toBeNull();
      expect(fn([0, null, 1]).reason).toBe("日收益缺失，无法进行多重检验");
      expect(fn([1e308, -1e308, 1]).value).toBeNull();
    }
    expect(sharpeVariance([null, 1]).value).toBeNull();
    expect(deflatedSharpeThreshold(2, -1).value).toBeNull();
    expect(deflatedSharpeThreshold(2.5, 1).value).toBeNull();
    expect(
      probabilisticSharpe({ ...moments, observations: 3.5 }).value,
    ).toBeNull();
    expect(probabilisticSharpe({ ...moments, sharpe: 1e308 }).value).toBeNull();
    expect(
      deflatedSharpeThreshold(Number.MAX_SAFE_INTEGER, 1).value,
    ).not.toBeNull();
    expect(() => multipleTesting(returns, [], 0)).toThrow("年化");
  });
});

describe("候选矩阵与滚动接入", () => {
  it("净值两根手算、缺失不跨日、零净值分母不补零", () => {
    // 本金100，110/100-1=0.1，99/110-1=-0.1。
    const r = equityDailyReturns([{ value: 110 }, { value: 99 }], 100);
    expect(r[0]).toBeCloseTo(0.1, 14);
    expect(r[1]).toBeCloseTo(-0.1, 14);
    expect(
      equityDailyReturns(
        [{ value: NaN }, { value: 100 }, { value: 0 }, { value: 100 }],
        100,
      ),
    ).toEqual([null, null, -1, null]);
  });
  it("候选、预热、窗口、成本与每条 equity 差分完全对应", () => {
    const costs = {
      ...defaultBacktestCosts,
      commissionBps: 9,
      slippageBps: 12,
    };
    const matrix = candidateTrialMatrix(
      source,
      strategy,
      100000,
      costs,
      options,
    );
    expect(matrix.candidates).toEqual(walkForwardCandidates(strategy));
    expect(matrix.returns).toHaveLength(matrix.candidates.length);
    expect(matrix.dates).toEqual(source.bars.slice(26).map((b) => b.date));
    matrix.candidates.forEach((candidate, i) => {
      const equity = backtest(
        source.bars,
        candidate,
        source.id,
        100000,
        costs,
        26,
      ).equity;
      expect(matrix.returns[i]).toHaveLength(214);
      equity.forEach((point, j) =>
        expect(matrix.returns[i]![j]).toBe(
          point.value / (j ? equity[j - 1]!.value : 100000) - 1,
        ),
      );
      expect(matrix.sharpes[i]).toBe(sharpeDaily(matrix.returns[i]!).value);
    });
  });
  it("只拼接各 fold 的测试日收益，年化参数不改变旧路径", () => {
    const wf = walkForward(
      source,
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    );
    const changed = walkForward(
      source,
      strategy,
      100000,
      defaultBacktestCosts,
      { ...options, yearlyDays: 365 },
    );
    const matrix = candidateTrialMatrix(
      source,
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    );
    const combined = wf.folds.flatMap((f) =>
      equityDailyReturns(f.test.equity, 100000),
    );
    expect(wf.multipleTesting).toEqual(
      multipleTesting(
        combined,
        matrix.sharpes.map((value, i) => ({
          value,
          reason: matrix.sharpeReasons[i]!,
        })),
      ),
    );
    expect(wf.multipleTesting!.selected.observations).toBe(140);
    expect(changed.multipleTesting!.selected.sharpeAnnual.value).toBe(
      wf.multipleTesting!.selected.sharpeDaily.value! * Math.sqrt(365),
    );
    expect(changed.summary).toEqual(wf.summary);
    expect(changed.folds).toEqual(wf.folds);
    expect(changed.multipleTesting!.selected.dsr).toEqual(
      wf.multipleTesting!.selected.dsr,
    );
    expect(wf.summary).not.toHaveProperty("dsr");
    expect(wf.assumptions.join(" ")).toContain("是实际试验数的下界");
  });
  it("合法空仓候选不删行，不补零，DSR 无法判定", () => {
    const noTrades = {
      ...source,
      bars: source.bars.map((b) => ({
        ...b,
        open: 100,
        close: 100,
        high: 100,
        low: 100,
      })),
    };
    const matrix = candidateTrialMatrix(
      noTrades,
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    );
    expect(matrix.sharpes).toEqual(matrix.candidates.map(() => null));
    expect(
      matrix.sharpeReasons.every((reason) => typeof reason === "string"),
    ).toBe(true);
    expect(
      matrix.returns.every((r) => r.length === 214 && r.every((v) => v === 0)),
    ).toBe(true);
    const wf = walkForward(
      noTrades,
      strategy,
      100000,
      defaultBacktestCosts,
      options,
    );
    expect(wf.multipleTesting!.trials).toBe(matrix.candidates.length);
    expect(wf.multipleTesting!.selected.dsr.value).toBeNull();
    expect(wf.multipleTesting!.sharpeVariance.reason).toBe(
      "候选夏普缺失，无法估计试验间方差",
    );
  });
  it("矩阵独立入口拒绝非法时点、频率和参数", () => {
    expect(() =>
      candidateTrialMatrix(
        { ...source, period: "5m" },
        strategy,
        100000,
        defaultBacktestCosts,
        options,
      ),
    ).toThrow("日线");
    expect(() =>
      candidateTrialMatrix(
        { ...source, historicalAsOf: "2025-01-10" },
        strategy,
        100000,
        defaultBacktestCosts,
        options,
      ),
    ).toThrow("截止");
    expect(() =>
      candidateTrialMatrix(
        { ...source, bars: [...source.bars].reverse() },
        strategy,
        100000,
        defaultBacktestCosts,
        options,
      ),
    ).toThrow("递增");
    expect(() =>
      candidateTrialMatrix(source, strategy, 0, defaultBacktestCosts, options),
    ).toThrow("资金");
  });
});

it("页面三档、原始原因、旧档案与出处局限始终可见", () => {
  const result = multipleTesting(returns, [
    { value: 0.1, reason: null },
    { value: 0.2, reason: null },
  ]);
  for (const [dsr, label] of [
    [0.95, "在记录到的 2 次试验下未被选择偏差解释"],
    [0.5, "不足以排除选择偏差"],
    [0.49, "更可能是选择偏差的产物"],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(MultipleTestingPanel, {
        result: {
          ...result,
          selected: { ...result.selected, dsr: { value: dsr, reason: null } },
        },
      }),
    );
    expect(html).toContain(label);
    expect(html).toContain("下界");
    expect(html).toContain("2014");
    expect(html).toContain("不构成业绩证据");
  }
  expect(
    renderToStaticMarkup(createElement(MultipleTestingPanel, {})),
  ).toContain("旧档案未记录");
  const unavailable = multipleTesting(
    [0, null, 1],
    [
      { value: 0.1, reason: null },
      { value: 0.2, reason: null },
    ],
  );
  expect(
    renderToStaticMarkup(
      createElement(MultipleTestingPanel, { result: unavailable }),
    ),
  ).toContain("无法判定：日收益缺失，无法进行多重检验");
});

it("极端正态尾部不截断为零，候选缺失原因为页面原文", () => {
  expect(normalCdf(-38)).toBeGreaterThan(0);
  const result = multipleTesting(returns, [
    { value: null, reason: "候选一：日收益方差为零" },
    { value: 0.2, reason: null },
  ]);
  const html = renderToStaticMarkup(
    createElement(MultipleTestingPanel, { result }),
  );
  expect(html).toContain("无法判定：候选一：日收益方差为零");
});
