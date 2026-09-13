import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  combinatoriallySymmetricCv as cv,
  cscvCombinations,
  performanceDegradation,
} from "../src/lib/backtest-overfit";
import { sharpeDaily, multipleTesting } from "../src/lib/multiple-testing";
import { MultipleTestingPanel } from "../src/components/multiple-testing-panel";

const series = (means: number[]) =>
  means.flatMap((m) =>
    Array.from({ length: 20 }, (_, i) => m + (i % 2 ? 0.01 : -0.01)),
  );
const stable = [series(Array(10).fill(0.02)), series(Array(10).fill(0.001))];
const average = (r: readonly (number | null)[]) => ({
  value: r.reduce<number>((s, n) => s + n!, 0) / r.length,
  reason: null,
});

describe("CSCV 组合与统计", () => {
  it.each([
    [4, 6],
    [10, 252],
  ])("S=%s 全组合及互补", (s, n) => {
    const combos = [...cscvCombinations(s)];
    expect(combos).toHaveLength(n);
    expect(new Set(combos.map((c) => c.train.join(","))).size).toBe(n);
    for (const c of combos) {
      expect(c.train).toHaveLength(s / 2);
      expect(c.test).toHaveLength(s / 2);
      expect(c.train.filter((i) => c.test.includes(i))).toEqual([]);
      expect([...c.train, ...c.test].sort((a, b) => a - b)).toEqual(
        Array.from({ length: s }, (_, i) => i),
      );
      expect(combos.some((other) => other.train.join() === c.test.join())).toBe(
        true,
      );
    }
  });
  it("每段一致最优，PBO=0；默认直接复用 V1 夏普", () => {
    const spy = vi.fn(sharpeDaily);
    const actual = cv({ returns: stable, metric: spy });
    expect(actual).toEqual(cv({ returns: stable }));
    expect(actual.combinations).toBe(252);
    expect(actual.pbo.value).toBe(0);
    expect(actual.probabilityOfLoss.value).toBe(0);
    expect(spy).toHaveBeenCalledTimes(252 * 4);
    spy.mock.calls.forEach(([r], i) =>
      expect(spy.mock.results[i]!.value).toEqual(sharpeDaily(r)),
    );
  });
  it("前半优势与后半劣势互换，所有训练赢家都在补集输掉", () => {
    // 权重 1,2,4,-7 的总和为零，无半数组合和为零；补集均值必反号。
    const a = series([0.001, 0.002, 0.004, -0.007]);
    const result = cv({ returns: [a, a.map((n) => -n)], splits: 4 });
    expect(result.pbo.value).toBe(1);
    expect(result.probabilityOfLoss.value).toBe(1);
    expect(result.performanceDegradation.slope.value).toBeLessThan(0);
    // 夏普分母随组合而变；均值指标才有精确的 test=-train。
    const meanResult = cv({
      returns: [a, a.map((n) => -n)],
      splits: 4,
      metric: average,
    });
    expect(meanResult.performanceDegradation.slope.value).toBeCloseTo(-1, 9);
    expect(meanResult.performanceDegradation.r2.value).toBeCloseTo(1, 9);
  });
  it("固定种子同分布独立无信息序列", () => {
    let seed = 42;
    const random = () => {
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const returns = Array.from({ length: 20 }, () =>
      Array.from({ length: 1000 }, () => (random() - 0.5) * 0.02),
    );
    const pbo = cv({ returns }).pbo.value!;
    expect(pbo).toBeGreaterThanOrEqual(0.3);
    expect(pbo).toBeLessThanOrEqual(0.7);
  });
  it("6 点回归手算", () => {
    // x=0..5, y=1+2x+e, e=[1,-2,1,0,0,0]；Σe=Σxe=0。
    // Sxx=17.5, Sxy=35, Syy=76 → slope=2, intercept=1, R²=70/76。
    const r = performanceDegradation(
      [2, 1, 6, 7, 9, 11].map((test, train) => ({ train, test })),
    );
    expect(r.slope.value).toBeCloseTo(2, 9);
    expect(r.intercept.value).toBeCloseTo(1, 9);
    expect(r.r2.value).toBeCloseTo(70 / 76, 9);
    expect(
      performanceDegradation([
        { train: 1, test: 2 },
        { train: 1, test: 3 },
      ]).slope.value,
    ).toBeNull();
    expect(
      performanceDegradation([
        { train: 1, test: 2 },
        { train: 2, test: 2 },
      ]).r2.value,
    ).toBeNull();
  });
  it("训练最优并列取小序号，样本外并列为平均排名", () => {
    const returns = [
      [4, 4, 0, 0],
      [4, 4, 2, 2],
      [0, 0, 1, 1],
    ].map((a) => a.flatMap((n) => Array(20).fill(n)));
    const r = cv({ returns, splits: 4, metric: average });
    // 首组合候选0/1并列训练最佳；取0，在样本外排名1，ω=1/4。
    expect(r.lambdas[0]).toBeCloseTo(Math.log(1 / 3), 12);
    const ties = [
      [4, 4, 1, 1],
      [3, 3, 1, 1],
      [0, 0, 2, 2],
    ].map((a) => a.flatMap((n) => Array(20).fill(n)));
    // 样本外选中者与候选1并列第1/2，平均1.5，ω=1.5/4。
    expect(
      cv({ returns: ties, splits: 4, metric: average }).lambdas[0],
    ).toBeCloseTo(Math.log(0.375 / 0.625), 12);
  });
});

describe("缺失与退化", () => {
  it.each([
    { returns: [stable[0]!], reason: "候选不足，无法排名" },
    { returns: stable, splits: 3, reason: "子段数必须是不小于 4 的偶数" },
    { returns: stable, splits: 2, reason: "子段数必须是不小于 4 的偶数" },
    {
      returns: stable.map((r) => r.slice(0, 199)),
      reason: "每个子段少于 20 个观测，排名不稳定",
    },
    { returns: [stable[0]!, stable[0]!], reason: "训练集无法区分候选" },
    {
      returns: [stable[0]!, [NaN, ...stable[1]!.slice(1)]],
      reason: "输入含非有限数",
    },
    {
      returns: [stable[0]!, [Infinity, ...stable[1]!.slice(1)]],
      reason: "输入含非有限数",
    },
  ])("$reason", ({ reason, ...input }) => {
    const result = cv(input);
    for (const m of [
      result.pbo,
      result.probabilityOfLoss,
      ...Object.values(result.performanceDegradation),
    ])
      expect(m).toEqual({ value: null, reason });
    expect(result.lambdas).toEqual([]);
  });
  it("105/10 丢5但样本不足；205/10 可计算且不拉伸", () => {
    const short = cv({ returns: stable.map((r) => r.slice(0, 105)) });
    expect(short.discardedPeriods).toBe(5);
    expect(short.periodLength).toBe(10);
    expect(short.pbo.value).toBeNull();
    const full = cv({
      returns: stable.map((r) => [...r, ...Array(5).fill(123)]),
    });
    expect(full.discardedPeriods).toBe(5);
    expect(full.periodLength).toBe(20);
    expect(full.lambdas).toEqual(cv({ returns: stable }).lambdas);
  });
  it("任一候选 null 整段共同作废，余奇数丢最后段且计数不重叠", () => {
    const returns: (number | null)[][] = stable.map((r) => [...r]);
    returns[0]![21] = null;
    returns[1]![22] = null;
    const result = cv({ returns });
    expect(result).toMatchObject({
      splits: 8,
      nullPeriods: 20,
      oddPeriods: 20,
      discardedPeriods: 40,
      combinations: 70,
    });
    const retained = returns.map((r) => [
      ...r.slice(0, 20),
      ...r.slice(40, 180),
    ]);
    expect(result.lambdas).toEqual(
      cv({ returns: retained, splits: 8 }).lambdas,
    );
    returns[1]![45] = null;
    expect(cv({ returns })).toMatchObject({
      splits: 8,
      nullPeriods: 40,
      oddPeriods: 0,
      discardedPeriods: 40,
    });
    expect(
      cv({ returns: stable.map((r) => r.map(() => null)) }).pbo.reason,
    ).toContain("不足 4");
  });
  it("不等长、零方差候选、非有限绩效及后续坏组合均不生成部分 PBO", () => {
    expect(
      cv({ returns: [stable[0]!, stable[1]!.slice(1)] }).pbo.value,
    ).toBeNull();
    expect(
      cv({ returns: [stable[0]!, Array(200).fill(0)] }).pbo.value,
    ).toBeNull();
    expect(
      cv({ returns: stable, metric: () => ({ value: Infinity, reason: null }) })
        .pbo.value,
    ).toBeNull();
    let calls = 0;
    const r = cv({
      returns: stable,
      metric: (values) =>
        ++calls > 4
          ? { value: null, reason: "后续坏组合" }
          : sharpeDaily(values),
    });
    expect(r.pbo).toEqual({ value: null, reason: "后续坏组合" });
    expect(r.lambdas).toEqual([]);
    expect(r.combinations).toBe(0);
  });
});

it("页面 PBO 三档与边界、原始原因和 V1 旧档案", () => {
  const result = multipleTesting(
    [-0.01, 0.02, 0.03],
    [
      { value: 1, reason: null },
      { value: 2, reason: null },
    ],
  );
  const overfit = cv({ returns: stable });
  for (const [pbo, label] of [
    [0, "基本保持排序"],
    [0.2, "基本保持排序"],
    [0.21, "部分失效"],
    [0.49, "部分失效"],
    [0.5, "不优于随机"],
    [1, "不优于随机"],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(MultipleTestingPanel, {
        result: {
          ...result,
          overfit: { ...overfit, pbo: { value: pbo, reason: null } },
        },
      }),
    );
    expect(html).toContain(label);
    expect(html).toContain("仅限当前");
    expect(html).toContain("不同于滚动检验");
    expect(html).toContain("2015");
    expect(html).toContain("性能衰减斜率");
    expect(html).not.toContain("lambdas");
  }
  expect(
    renderToStaticMarkup(createElement(MultipleTestingPanel, { result })),
  ).toContain("旧档案未记录 PBO");
  expect(
    renderToStaticMarkup(
      createElement(MultipleTestingPanel, {
        result: {
          ...result,
          overfit: { ...overfit, pbo: { value: null, reason: "精确缺失原因" } },
        },
      }),
    ),
  ).toContain("无法判定：精确缺失原因");
});
