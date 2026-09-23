import { describe, expect, it } from "vitest";
import {
  dailyPerformance,
  type DailyPerformance,
  type DailyPerformanceInput,
} from "../../../src/lib/backtest/daily-performance";

const keys = [
  "totalReturn",
  "annualReturn",
  "sharpeWbt",
  "maxDrawdown",
  "calmar",
  "dailyWinRate",
  "dailyPayoffRatio",
  "dailyEdge",
  "annualVolatility",
  "downsideVolatility",
  "nonzeroCoverage",
  "breakEvenPoint",
  "newHighInterval",
  "newHighRatio",
  "drawdownRisk",
  "regressionAnnualReturn",
  "lengthAdjustedAverageDrawdown",
] as const satisfies readonly (keyof DailyPerformance)[];
const simple = (returns: readonly (number | null)[]) =>
  dailyPerformance({ returns, basis: "simple", annualRiskFreeRate: 0 });

describe("U1 日收益指标核", () => {
  // §3 内联 wbt 表：17 项逐列比对，四位显示容差；不在数据层舍入。
  // wbt 常数夏普/回撤风险填0、无回撤卡玛填10、无亏损盈亏比/赢面填5，按 §2.4 留空。
  // 无负收益时 std(空集) 无定义；全负时 mean(非负空集) 无定义，不能用0补造。
  const columns = [
    {
      returns: [0.1, -0.1],
      expected: [
        0, 0, 0, 0.1, 0, 0.5, 1, 0, 1.5875, 0, 1, 1, 1, 0.5, 0.063, -25.2,
        0.0008,
      ],
    },
    {
      returns: [0.01, 0.01, 0.01],
      expected: [
        0.03,
        2.52,
        null,
        0,
        null,
        1,
        null,
        null,
        0,
        null,
        1,
        0.3333,
        0,
        1,
        null,
        2.52,
        0,
      ],
    },
    // wbt 卡玛 clamp(-84)=-10，按 §2.4 保留 -2.52/0.03=-84；盈亏比0、赢面-1改为null。
    {
      returns: [-0.01, -0.01, -0.01],
      expected: [
        -0.03,
        -2.52,
        null,
        0.03,
        -84,
        0,
        null,
        null,
        0,
        0,
        1,
        1,
        3,
        0,
        null,
        -2.52,
        0.0016,
      ],
    },
    // 任务书 §3 全零整列留空与有效观测事实不符；按 §2.1/2.3 保留已定义量。
    // 零算胜且持平算新高，胜率/新高占比=1；累计和从未>0，平衡点=1；OLS常数斜率=0。
    {
      returns: [0, 0, 0],
      expected: [
        0,
        0,
        null,
        0,
        null,
        1,
        null,
        null,
        0,
        null,
        0,
        1,
        0,
        1,
        null,
        0,
        0,
      ],
    },
  ];
  it.each(columns)("wbt 表 $returns", ({ returns, expected }) => {
    const result = simple(returns);
    expect(keys).toHaveLength(17);
    for (const [i, key] of keys.entries()) {
      if (expected[i] === null) {
        expect(result[key].value, key).toBeNull();
        expect(result[key].reason, key).toEqual(expect.any(String));
        expect(result[key].reason!.length, key).toBeGreaterThan(0);
      } else {
        expect(result[key].value, key).toBeCloseTo(expected[i]!, 4);
        expect(result[key].reason, key).toBeNull();
      }
    }
  });

  it.each([{ returns: [] }, { returns: [null] }, { returns: [null, null] }])(
    "无可得观测 $returns 全部留空",
    ({ returns }) => {
      const result = simple(returns);
      for (const key of keys) {
        expect(result[key].value).toBeNull();
        expect(result[key].reason).toEqual(expect.any(String));
      }
      expect(result.coverage).toEqual({
        observedDays: returns.length,
        availableDays: 0,
        nullDays: returns.length,
        zeroReturnDays: 0,
      });
    },
  );

  it("零和 null 分开计数，输入不变，null 不参与指标计算", () => {
    const returns = Object.freeze([null, 0.1, 0, null, -0.1]);
    const result = simple(returns);
    const complete = simple([0.1, 0, -0.1]);
    for (const key of keys) expect(result[key]).toEqual(complete[key]);
    expect(result.coverage).toEqual({
      observedDays: 5,
      availableDays: 3,
      nullDays: 2,
      zeroReturnDays: 1,
    });
    // 胜率2/3；非负均值0.05/亏损均值0.1=0.5；赢面2/3*0.5-1/3=0。
    expect(result.dailyWinRate.value).toBe(2 / 3);
    expect(result.dailyPayoffRatio.value).toBe(0.5);
    expect(result.dailyEdge.value).toBeCloseTo(0, 14);
    expect(returns).toEqual([null, 0.1, 0, null, -0.1]);
  });

  it("单日首亏计入本金回撤，斜率不可估", () => {
    const result = dailyPerformance({ returns: [-0.1] });
    expect(result.totalReturn.value).toBeCloseTo(-0.1, 14);
    expect(result.maxDrawdown.value).toBeCloseTo(0.1, 14);
    expect(result.newHighInterval.value).toBe(1);
    expect(result.regressionAnnualReturn).toEqual({
      value: null,
      reason: "不足两个可得日收益，回归斜率无定义",
    });
    expect(result.sharpeWbt.value).toBeNull();
    expect(result.downsideVolatility.value).toBe(0);
  });

  it("复利与单利曲线独立，默认参数回显", () => {
    const compound = dailyPerformance({ returns: [0.1, -0.1] });
    // 1.1*0.9=0.99；年化0.99^126-1；OLS两点净值差=-0.11，年化=-27.72。
    expect(compound.basis).toBe("compound");
    expect(compound.yearlyDays).toBe(252);
    expect(compound.annualRiskFreeRate).toBe(0.02);
    expect(compound.totalReturn.value).toBeCloseTo(-0.01, 14);
    expect(compound.annualReturn.value).toBeCloseTo(0.99 ** 126 - 1, 12);
    expect(compound.maxDrawdown.value).toBeCloseTo(0.1, 14);
    expect(compound.regressionAnnualReturn.value).toBeCloseTo(-27.72, 12);
    expect(simple([0.1, -0.1]).totalReturn.value).toBe(0);
  });

  it("年化天数驱动所有年化量，rf不改变wbt夏普", () => {
    const returns = [0.1, -0.2, -0.1];
    const a = dailyPerformance({
      returns,
      basis: "simple",
      yearlyDays: 100,
      annualRiskFreeRate: 0,
    });
    const b = dailyPerformance({
      returns,
      basis: "simple",
      yearlyDays: 400,
      annualRiskFreeRate: 0.15,
    });
    expect(b.yearlyDays).toBe(400);
    expect(b.annualRiskFreeRate).toBe(0.15);
    for (const key of [
      "annualReturn",
      "regressionAnnualReturn",
      "calmar",
    ] as const)
      expect(b[key].value).toBeCloseTo(a[key].value! * 4, 12);
    for (const key of [
      "sharpeWbt",
      "annualVolatility",
      "downsideVolatility",
    ] as const)
      expect(b[key].value).toBeCloseTo(a[key].value! * 2, 12);
    expect(b.drawdownRisk.value).toBeCloseTo(a.drawdownRisk.value! / 2, 12);
    expect(b.lengthAdjustedAverageDrawdown.value).toBe(
      a.lengthAdjustedAverageDrawdown.value! / 4,
    );
    expect(
      dailyPerformance({ returns: [0.1, -0.1], yearlyDays: 2 }).annualReturn
        .value,
    ).toBeCloseTo(-0.01, 14);
  });

  it("总体下行标准差只除亏损日数，且不减rf", () => {
    // 负收益[-0.1,-0.3]均值-0.2，方差(0.01+0.01)/2=0.01；年化天数100=>1。
    expect(
      dailyPerformance({ returns: [0.9, -0.1, -0.3, 0], yearlyDays: 100 })
        .downsideVolatility.value,
    ).toBeCloseTo(1, 14);
  });

  it("严格水下连续长度，持平会中断，首亏也计入", () => {
    // 累计[-1,0,0,-1,-1,0,-1]：连续段长度1、2、1；持平前高共3日。
    const result = simple([-1, 1, 0, -1, 0, 1, -1]);
    expect(result.newHighInterval.value).toBe(2);
    expect(result.newHighRatio.value).toBe(3 / 7);
    expect(simple([1, 0, 0, 0]).newHighInterval.value).toBe(0);
  });

  it("盈亏平衡必须严格转正，不能把累计零当成盈利", () => {
    expect(simple([-1, 1, 1]).breakEvenPoint.value).toBe(1);
    expect(simple([0, 1, 2]).breakEvenPoint.value).toBe(2 / 3);
    expect(simple([-2, 1]).breakEvenPoint.value).toBe(1);
  });

  it("微小波动用未舍入分母，夏普与卡玛不clamp", () => {
    expect(simple([1e-6, -1e-6]).drawdownRisk.value).toBeCloseTo(
      1 / Math.sqrt(252),
      14,
    );
    expect(simple([0.01, 0.010001]).sharpeWbt.value!).toBeGreaterThan(10);
    expect(simple([-0.01, -0.01]).calmar.value).toBe(-126);
  });

  it("Top-5迭代剥离，缺少五段仍除5，初始虚拟bar不计长度", () => {
    // 每段[+2,-1,+1]回撤长度1；六段只取五段，5/5/252。
    expect(
      simple(Array.from({ length: 6 }, () => [2, -1, 1]).flat())
        .lengthAdjustedAverageDrawdown.value,
    ).toBe(1 / 252);
    expect(simple([2, -1, 1]).lengthAdjustedAverageDrawdown.value).toBe(
      1 / 5 / 252,
    );
    expect(simple([-1, -1, -1]).lengthAdjustedAverageDrawdown.value).toBe(
      2 / 5 / 252,
    );
    // 累计[4,2,3,1,4]只有一个大回撤，峰0至谷3；不能重复计入内部反弹。
    expect(simple([4, -2, 1, -2, 3]).lengthAdjustedAverageDrawdown.value).toBe(
      3 / 5 / 252,
    );
  });

  it("复利本金归零有定义，低于-100%的曲线量留空", () => {
    const zero = dailyPerformance({ returns: [-1, 0] });
    expect(zero.totalReturn.value).toBe(-1);
    expect(zero.maxDrawdown.value).toBe(1);
    const invalid = dailyPerformance({ returns: [-1.1, 0.1] });
    for (const key of [
      "totalReturn",
      "annualReturn",
      "maxDrawdown",
      "calmar",
      "newHighInterval",
      "newHighRatio",
      "drawdownRisk",
      "regressionAnnualReturn",
      "lengthAdjustedAverageDrawdown",
    ] as const) {
      expect(invalid[key].value).toBeNull();
      expect(invalid[key].reason).toContain("低于 -100%");
    }
    expect(invalid.dailyWinRate.value).toBe(0.5);
    expect(simple([-1.1, 0.1]).totalReturn.value).toBe(-1);
  });

  it.each([
    { yearlyDays: 0 },
    { yearlyDays: -1 },
    { yearlyDays: Infinity },
    { annualRiskFreeRate: -1 },
    { annualRiskFreeRate: NaN },
    { returns: [Infinity] },
    { returns: [NaN] },
  ])("非法输入显式拒绝 %j", (extra) => {
    expect(() =>
      dailyPerformance({ returns: [0.1], ...extra } as DailyPerformanceInput),
    ).toThrow();
  });

  it("计算溢出不能泄露Infinity或NaN", () => {
    const result = dailyPerformance({ returns: [10], yearlyDays: 1000 });
    expect(result.annualReturn.value).toBeNull();
    expect(result.annualReturn.reason).toContain("溢出");
    for (const key of keys)
      if (result[key].value !== null)
        expect(Number.isFinite(result[key].value)).toBe(true);
  });
});
