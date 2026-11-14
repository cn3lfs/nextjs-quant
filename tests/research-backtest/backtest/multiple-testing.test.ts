import { describe, expect, it } from "vitest";
import { dailyPerformance } from "../../../src/lib/backtest/daily-performance";
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
} from "../../../src/lib/backtest/multiple-testing";
const moments = { sharpe: 0.1, observations: 101, skewness: 0, kurtosis: 3 };
const returns = [-0.02, 0.01, 0.03, -0.01, 0.005, 0.02];
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

it("preserves extreme tails and candidate failure reasons", () => {
  expect(normalCdf(-38)).toBeGreaterThan(0);
  const result = multipleTesting(returns, [
    { value: null, reason: "候选一：日收益方差为零" },
    { value: 0.2, reason: null },
  ]);
  expect(result.trialSharpeReasons).toContain("候选一：日收益方差为零");
});
