import { expect, it } from "vitest";
import {
  evaluatePerformance,
  performancePeriods,
  type PerformancePoint,
} from "../src/index.js";

const points: PerformancePoint[] = [
  { date: "2025-01-02", value: 110, benchmarkReturn: 0.02 },
  { date: "2025-01-03", value: 88, benchmarkReturn: -0.03 },
  { date: "2025-01-06", value: 110, benchmarkReturn: 0.01 },
];
it("includes the first day, uses arithmetic excess/sample risk and measures calendar recovery", () => {
  const r = evaluatePerformance(100, points);
  expect(r.totalReturn.value).toBeCloseTo(0.1, 12);
  expect(r.maxDrawdown.value).toBeCloseTo(0.2, 12);
  const rf = 1.02 ** (1 / 252) - 1;
  expect(r.sharpe.value).toBeCloseTo(
    ((0.05 - rf) / Math.sqrt(0.0525)) * Math.sqrt(252),
    10,
  );
  expect(r.informationRatio.value).toBeCloseTo(
    (0.05 / Math.sqrt(0.0427)) * Math.sqrt(252),
    10,
  );
  expect(r.benchmarkReturn.value).toBeCloseTo(1.02 * 0.97 * 1.01 - 1, 12);
  expect(r.sortino.value).toBeCloseTo(
    ((0.05 - rf) * Math.sqrt(252)) / Math.sqrt((-0.2 - rf) ** 2 / 3),
    10,
  );
  expect(r.recoveryDays.value).toBe(3);
  expect(r.longestUnderwaterDays.value).toBe(4);
  expect(r.maxDrawdownEpisode).toMatchObject({
    peakDate: "2025-01-02",
    valleyDate: "2025-01-03",
    recoveryDate: "2025-01-06",
  });
  expect(r.annualReturn.value).toBeNull();
  expect(r.calmar.value).toBeNull();
});
it("periods compound to the full result and cannot use future recovery across month or quarter boundaries", () => {
  const rows = [
    { date: "2024-12-30", value: 100 },
    { date: "2024-12-31", value: 80 },
    { date: "2025-01-02", value: 90 },
    { date: "2025-01-06", value: 110 },
  ];
  for (const frequency of ["year", "quarter", "month"] as const) {
    const periods = performancePeriods(100, rows, frequency);
    expect(
      periods.reduce((v, p) => v * (1 + p.evaluation.totalReturn.value!), 1) -
        1,
    ).toBeCloseTo(0.1, 12);
    expect(periods[0]!.evaluation.maxDrawdownEpisode?.recoveryDate).toBeNull();
    expect(periods[0]!.evaluation.recoveryDays.value).toBeNull();
    expect(periods[0]!.evaluation.recoveryDays.reason).toContain("未修复");
    expect(periods[1]!.evaluation.initial).toBe(80);
  }
  expect(evaluatePerformance(100, rows).maxDrawdownEpisode?.recoveryDate).toBe(
    "2025-01-06",
  );
});
it("reports no recovery as censored, and chooses the latest equal peak and earliest tied drawdown", () => {
  const r = evaluatePerformance(100, [
    { date: "2025-01-02", value: 100 },
    { date: "2025-01-03", value: 100 },
    { date: "2025-01-06", value: 80 },
    { date: "2025-01-07", value: 80 },
    { date: "2025-01-08", value: 90 },
  ]);
  expect(r.maxDrawdownEpisode).toMatchObject({
    peakDate: "2025-01-03",
    valleyDate: "2025-01-06",
    recoveryDate: null,
    observedRecoveryDays: 2,
  });
  expect(r.recoveryDays.value).toBeNull();
  expect(r.longestUnderwaterDays.value).toBe(5);
});
it("only annualizes compound return after 252 observations and keeps degenerate ratios empty", () => {
  const rows = Array.from({ length: 252 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    value: i === 251 ? 110 : 100,
    benchmarkReturn: 0,
  }));
  expect(evaluatePerformance(100, rows).annualReturn.value).toBeCloseTo(0.1);
  const flat = rows.map((p) => ({ ...p, value: 100 }));
  const r = evaluatePerformance(100, flat);
  expect(r.sharpe.value).toBeNull();
  expect(r.informationRatio.value).toBeNull();
  expect(r.calmar.value).toBeNull();
  expect(r.maxDrawdown.value).toBe(0);
  expect(r.recoveryDays.reason).toContain("不适用");
  expect(r.longestUnderwaterDays.value).toBe(0);
  expect(evaluatePerformance(100, []).totalReturn.value).toBeNull();
});
it("does not fill missing benchmark returns and rejects invalid dates/equity or shuffled inputs", () => {
  const partial = points.map((p, i) => ({
    ...p,
    benchmarkReturn: i ? p.benchmarkReturn : undefined,
  }));
  expect(evaluatePerformance(100, partial).informationRatio.value).toBeNull();
  expect(() => evaluatePerformance(100, [...points].reverse())).toThrow("日期");
  for (const point of [
    { date: "2025-02-30", value: 100 },
    { date: "2025-01-02", value: -1 },
    { date: "2025-01-02", value: NaN },
  ])
    expect(() => evaluatePerformance(100, [point])).toThrow();
  expect(() =>
    performancePeriods(100, [points[0]!, points[0]!], "month"),
  ).toThrow();
});

it("parameterizes annualization for 24/7 crypto instead of assuming 252", () => {
  const rows: PerformancePoint[] = Array.from({ length: 300 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10),
    value: 100 + i * 0.1,
  }));
  const cn = evaluatePerformance(100, rows);
  const crypto = evaluatePerformance(100, rows, rows[0]!.date, 365);
  expect(cn.shortSample).toBe(false);
  expect(crypto.shortSample).toBe(true);
  expect(crypto.annualReturn.value).toBeNull();
  expect(crypto.annualReturn.reason).toContain("365");
  expect(
    crypto.annualVolatility.value! / cn.annualVolatility.value!,
  ).toBeCloseTo(Math.sqrt(365 / 252), 12);
});

it("evaluates a total-loss equity curve instead of throwing on zero", () => {
  const r = evaluatePerformance(100, [
    { date: "2025-01-02", value: 50 },
    { date: "2025-01-03", value: 0 },
  ]);
  expect(r.totalReturn.value).toBe(-1);
  expect(r.maxDrawdown.value).toBe(1);
});
