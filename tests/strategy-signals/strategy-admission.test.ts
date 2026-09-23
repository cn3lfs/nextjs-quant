import { describe, expect, it } from "vitest";
import { dailyPerformance } from "../../src/lib/backtest/daily-performance";
import {
  strategyAdmission,
  defaultAdmissionParams,
  type StrategyAdmissionInput,
} from "../../src/lib/strategy-facts/strategy-admission";

const dates = (n: number, start = "2024-01-01") =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10),
  );
const base = (
  extra: Partial<StrategyAdmissionInput> = {},
): StrategyAdmissionInput => ({
  dates: dates(3),
  strategyDaily: [-0.02, 0.01, -0.005],
  benchDaily: [-0.04, 0, -0.01],
  evidenceLevel: "合成/受控样本",
  mode: "history",
  params: {
    minYearDays: 3,
    maxDdThreshold: 0,
    maxAlphaDdThreshold: 10,
    minFullSharpe: -1000000,
  },
  ...extra,
});
function history(input = base()) {
  const result = strategyAdmission({ ...input, mode: "history" });
  if (result.mode !== "history") throw new Error("history expected");
  return result;
}
function recent(input = base()) {
  const result = strategyAdmission({ ...input, mode: "recent" });
  if (result.mode !== "recent") throw new Error("recent expected");
  return result;
}
function alphaOf(
  input: StrategyAdmissionInput,
  yearlyDays = 252,
  targetVol = 0.2,
) {
  const stats = (returns: readonly (number | null)[]) =>
    dailyPerformance({
      returns,
      basis: "simple",
      annualRiskFreeRate: 0,
      yearlyDays,
    });
  const long = input.longDaily ?? input.strategyDaily;
  const longVol = stats(long).annualVolatility.value!;
  const benchVol = stats(input.benchDaily).annualVolatility.value!;
  return {
    alpha: long.map(
      (v, i) =>
        v! * (targetVol / longVol) -
        input.benchDaily[i]! * (targetVol / benchVol),
    ),
    stats,
  };
}

describe("逐年三选一与全样本条件", () => {
  it("只有第2路通过，整体通过", () => {
    const result = history();
    expect(result.yearlyMetrics[0]).toMatchObject({
      condAbsReturnPassed: false,
      condAlphaReturnPassed: true,
      condAlphaDrawdownPassed: false,
      yearPassed: true,
    });
    expect(result.isGood).toBe(true);
  });
  it("只有第3路通过，整体通过", () => {
    const result = history(
      base({
        benchDaily: [-0.01, 0.03, 0],
        params: { ...base().params, maxDdThreshold: 10 },
      }),
    );
    expect(result.yearlyMetrics[0]).toMatchObject({
      condAbsReturnPassed: false,
      condAlphaReturnPassed: false,
      condAlphaDrawdownPassed: true,
      yearPassed: true,
    });
    expect(result.isGood).toBe(true);
  });
  it("三路全败即使硬门满足也整体失败", () => {
    const result = history(base({ benchDaily: [-0.01, 0.03, 0] }));
    expect(result.yearlyMetrics[0]).toMatchObject({
      condAbsReturnPassed: false,
      condAlphaReturnPassed: false,
      condAlphaDrawdownPassed: false,
      yearPassed: false,
    });
    expect(result.condAlphaDrawdownPassed).toBe(true);
    expect(result.condSharpePassed).toBe(true);
    expect(result.isGood).toBe(false);
  });
  it.each([199, 200, 201])("完整年 %i 日边界", (n) => {
    const result = history(
      base({
        dates: dates(n),
        strategyDaily: Array.from({ length: n }, (_, i) =>
          i % 2 ? 0.02 : -0.01,
        ),
        benchDaily: Array.from({ length: n }, (_, i) => (i % 3 ? -0.01 : 0.01)),
        params: {},
      }),
    );
    expect(result.yearlyMetrics[0]!.isCompleteYear).toBe(n >= 200);
    expect(result.completeYearCount).toBe(n >= 200 ? 1 : 0);
    if (n === 199) {
      expect(result.isGood).toBe(false);
      expect(result.reasons.some((r) => r.includes("no complete year"))).toBe(
        true,
      );
    }
  });
  it("逐年回撤恰好等于阈值不走第3路（严格小于）", () => {
    const input = base({ benchDaily: [-0.01, 0.03, 0] });
    const dd = history(input).yearlyMetrics[0]!.alphaMaxDrawdown.value!;
    expect(dd).toBeGreaterThan(0);
    expect(
      history({ ...input, params: { ...input.params, maxDdThreshold: dd } })
        .yearlyMetrics[0]!.condAlphaDrawdownPassed,
    ).toBe(false);
  });
  it("全样本回撤恰好等于阈值通过（≤），略低于实际回撤失败", () => {
    const input = base({
      benchDaily: [-0.01, 0.03, 0],
      params: { ...base().params, maxDdThreshold: 10 },
    });
    const { alpha, stats } = alphaOf(input);
    const dd = stats(alpha).maxDrawdown.value!;
    expect(dd).toBeGreaterThan(0);
    const result = history({
      ...input,
      params: { ...input.params, maxAlphaDdThreshold: dd },
    });
    expect(result.historyAlphaMaxDrawdown.value).toBe(dd);
    expect(result.condAlphaDrawdownPassed).toBe(true);
    expect(result.isGood).toBe(true);
    expect(
      history({
        ...input,
        params: { ...input.params, maxAlphaDdThreshold: dd - 1e-8 },
      }).condAlphaDrawdownPassed,
    ).toBe(false);
  });
  it("全样本 Sharpe 恰好等于阈值失败（>），略低阈值才通过", () => {
    const input = base();
    const { alpha, stats } = alphaOf(input);
    const sharpe = stats(alpha).sharpeWbt.value!;
    expect(Number.isFinite(sharpe)).toBe(true);
    const result = history({
      ...input,
      params: { ...input.params, minFullSharpe: sharpe },
    });
    expect(result.historyAlphaSharpe.value).toBe(sharpe);
    expect(result.condSharpePassed).toBe(false);
    expect(result.isGood).toBe(false);
    expect(
      history({
        ...input,
        params: { ...input.params, minFullSharpe: sharpe - 1e-8 },
      }).condSharpePassed,
    ).toBe(true);
  });
  it("任一完整年失败，不能被其他盈利年份覆盖", () => {
    const result = history(
      base({
        dates: [...dates(3), ...dates(3, "2025-01-01")],
        strategyDaily: [-0.02, 0.01, -0.005, 0.01, 0.04, 0.02],
        benchDaily: [-0.01, 0.03, 0, -0.01, 0.03, 0],
      }),
    );
    expect(result.completeYearCount).toBe(2);
    expect(result.yearlyMetrics.map((y) => y.yearPassed)).toEqual([
      false,
      true,
    ]);
    expect(result.condYearsPassed).toBe(false);
    expect(result.isGood).toBe(false);
  });
});

describe("退化防护", () => {
  it.each(["benchDaily", "strategyDaily"] as const)(
    "%s 零波动绝不能因0回撤通过第3路",
    (key) => {
      const result = history(
        base({
          [key]: [-0.01, -0.01, -0.01],
          params: { ...base().params, maxDdThreshold: 0.2 },
        }),
      );
      expect(result.alphaDegenerate).toBe(true);
      expect(result.isGood).toBe(false);
      expect(result.historyAlphaMaxDrawdown.value).toBeNull();
      expect(result.historyAlphaSharpe.value).toBeNull();
      expect(result.longScale.value).toBeNull();
      expect(result.benchScale.value).toBeNull();
      expect(result.condAlphaDrawdownPassed).toBe(false);
      expect(result.yearlyMetrics[0]).toMatchObject({
        alphaReturn: { value: null },
        alphaMaxDrawdown: { value: null },
        condAlphaReturnPassed: false,
        condAlphaDrawdownPassed: false,
      });
    },
  );
  it("退化时允许绝对收益一路满足，但不能整体通过", () => {
    const result = history(base({ strategyDaily: [0.01, 0.01, 0.01] }));
    expect(result.yearlyMetrics[0]!.yearPassed).toBe(true);
    expect(result.isGood).toBe(false);
  });
  it.each([NaN, Infinity, -Infinity])(
    "NaN/Inf 收益按 §2.1 明确退化：%s",
    (value) => {
      for (const key of ["benchDaily", "longDaily", "strategyDaily"] as const) {
        const result = history(base({ [key]: [0.01, value, -0.01] }));
        expect(result.alphaDegenerate).toBe(true);
        expect(result.isGood).toBe(false);
        expect(result.historyAlphaMaxDrawdown.value).toBeNull();
        expect(result.yearlyMetrics[0]!.condAlphaDrawdownPassed).toBe(false);
      }
    },
  );
  it("小于 1e-12 的年化波动率、数值溢出与缺失均不制造超额路径", () => {
    for (const values of [
      [0, 1e-16, -1e-16],
      [1e308, -1e308, 1e308],
      [0.01, null, -0.01],
    ]) {
      const result = history(base({ benchDaily: values }));
      expect(result.alphaDegenerate).toBe(true);
      expect(result.isGood).toBe(false);
      expect(result.historyAlphaMaxDrawdown.value).toBeNull();
    }
  });
  it("recent 退化也不通过第三路或硬门", () => {
    const result = recent(
      base({
        benchDaily: [0, 0, 0],
        params: { recentDays: 1, minHistoryDays: 0 },
      }),
    );
    expect(result.alphaDegenerate).toBe(true);
    expect(result.condAlphaDrawdownPassed).toBe(false);
    expect(result.condImprovementPassed).toBe(false);
    expect(result.recentAlphaMaxDrawdown.value).toBeNull();
    expect(result.historyAlphaMaxDrawdownExclRecent.value).toBeNull();
    expect(result.isGood).toBe(false);
  });
});

describe("recent 错开窗口及口径", () => {
  it("全样本共用归一化 scale，历史确实剔除 recent 窗口", () => {
    const input = base({
      dates: dates(8),
      strategyDaily: [0.1, -0.2, 0.03, -0.1, 0.02, 0.03, 0.04, 0.02],
      benchDaily: [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.02, -0.02],
      params: { recentDays: 3, minHistoryDays: 2 },
    });
    const { alpha, stats } = alphaOf(input);
    const result = recent(input);
    expect(result.recentStartDate).toBe(input.dates[5]);
    expect(result.recentEndDate).toBe(input.dates[7]);
    expect(result.recentActualDays).toBe(3);
    expect(result.recentAlphaReturn).toEqual(stats(alpha.slice(5)).totalReturn);
    expect(result.recentAlphaMaxDrawdown).toEqual(
      stats(alpha.slice(5)).maxDrawdown,
    );
    expect(result.historyAlphaMaxDrawdownExclRecent).toEqual(
      stats(alpha.slice(0, 5)).maxDrawdown,
    );
    expect(result.condImprovementPassed).toBe(true);
    expect(result.isGood).toBe(true);
    const independentlyScaled = alphaOf({
      ...input,
      strategyDaily: input.strategyDaily.slice(5),
      benchDaily: input.benchDaily.slice(5),
    });
    expect(result.recentAlphaReturn.value).not.toBe(
      independentlyScaled.stats(independentlyScaled.alpha).totalReturn.value,
    );
  });
  it("recent 与历史回撤同为零时硬门不通过（严格小于）", () => {
    const result = recent(
      base({
        strategyDaily: [0.02, 0.03, 0.04],
        benchDaily: [0.01, 0.02, 0.03],
        params: { recentDays: 1, minHistoryDays: 0 },
      }),
    );
    expect(result.recentAlphaMaxDrawdown.value).toBe(0);
    expect(result.historyAlphaMaxDrawdownExclRecent.value).toBe(0);
    expect(result.condImprovementPassed).toBe(false);
  });
  it("历史只有59日不足60日；0关闭floor但不伪造空历史", () => {
    const input = base({
      dates: dates(62),
      strategyDaily: Array.from({ length: 62 }, (_, i) =>
        i % 2 ? -0.01 : 0.02,
      ),
      benchDaily: Array.from({ length: 62 }, (_, i) => (i % 3 ? 0.01 : -0.01)),
      params: { recentDays: 3, minHistoryDays: 60 },
    });
    expect(recent(input).historyWindowEmpty).toBe(true);
    expect(recent(input).isGood).toBe(false);
    expect(
      recent({ ...input, params: { ...input.params, minHistoryDays: 0 } })
        .historyWindowEmpty,
    ).toBe(false);
    expect(
      recent({ ...input, params: { recentDays: 100, minHistoryDays: 0 } })
        .historyWindowEmpty,
    ).toBe(true);
  });
  it("逐项锚定 U1 simple + rf=0，年化因子来自参数", () => {
    const input = base({
      params: { ...base().params, yearlyDays: 365, targetVol: 0.4 },
    });
    const result = history(input);
    const { alpha, stats } = alphaOf(input, 365, 0.4);
    expect(result.basis).toBe("simple");
    expect(result.annualRiskFreeRate).toBe(0);
    expect(result.longAnnualVolatility).toEqual(
      stats(input.strategyDaily).annualVolatility,
    );
    expect(result.historyAlphaSharpe).toEqual(stats(alpha).sharpeWbt);
    expect(result.historyAlphaMaxDrawdown).toEqual(stats(alpha).maxDrawdown);
    expect(result.yearlyMetrics[0]!.absReturn).toEqual(
      stats(input.strategyDaily).totalReturn,
    );
    expect(result.yearlyMetrics[0]!.alphaReturn).toEqual(
      stats(alpha).totalReturn,
    );
    expect(result.yearlyMetrics[0]!.alphaMaxDrawdown).toEqual(
      stats(alpha).maxDrawdown,
    );
    expect(result.yearlyMetrics[0]!.absReturn.value).not.toBe(
      dailyPerformance({ returns: input.strategyDaily, basis: "compound" })
        .totalReturn.value,
    );
  });
  it("完整回显所有参数、保留可选多头腿和证据级别", () => {
    const input = base({
      longDaily: [0.02, 0.04, -0.01],
      evidenceLevel: "本地模拟未独立核验",
    });
    const result = history(input);
    expect(result.params).toEqual({
      ...defaultAdmissionParams,
      ...input.params,
    });
    expect(result.longIsStrategy).toBe(false);
    expect(result.evidenceLevel).toBe(input.evidenceLevel);
    expect(history().longIsStrategy).toBe(true);
    expect(Array.isArray(result.reasons)).toBe(true);
    const replay = JSON.parse(
      JSON.stringify({ input: { ...input, params: result.params }, result }),
    ) as { input: StrategyAdmissionInput; result: ReturnType<typeof history> };
    expect(history(replay.input)).toEqual(replay.result);
  });
});

it("空样本失败且无完整年，不把空收益算零", () => {
  const result = history(
    base({ dates: [], strategyDaily: [], benchDaily: [] }),
  );
  expect(result.isGood).toBe(false);
  expect(result.completeYearCount).toBe(0);
  expect(result.historyAlphaMaxDrawdown.value).toBeNull();
});
it("日期、长度、模式和阈值校验抛错，不静默降级", () => {
  for (const patch of [
    { dates: dates(2) },
    { longDaily: [0] },
    { benchDaily: [] },
    { dates: ["2024-02-30", "2024-03-01", "2024-03-02"] },
    { dates: ["2024-01-02", "2024-01-01", "2024-01-03"] },
    { dates: ["2024-01-01", "2024-01-01", "2024-01-03"] },
    { params: { recentDays: 0 } },
    { params: { targetVol: 0 } },
    { params: { targetVol: -1 } },
    { params: { maxDdThreshold: NaN } },
    { params: { minFullSharpe: Infinity } },
    { params: { minYearDays: 1.5 } },
    { params: { yearlyDays: 0 } },
    { params: { minHistoryDays: -1 } },
  ])
    expect(() => strategyAdmission(base(patch))).toThrow();
  expect(() =>
    strategyAdmission({
      ...base(),
      mode: "unknown",
    } as unknown as StrategyAdmissionInput),
  ).toThrow();
  expect(() =>
    strategyAdmission({
      ...base(),
      evidenceLevel: "unknown",
    } as unknown as StrategyAdmissionInput),
  ).toThrow();
  for (const patch of [
    { longDaily: null },
    { params: null },
    { strategyDaily: ["0", 0, 0] },
  ])
    expect(() =>
      strategyAdmission({
        ...base(),
        ...patch,
      } as unknown as StrategyAdmissionInput),
    ).toThrow();
});
