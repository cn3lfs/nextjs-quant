import { expect, it } from "vitest";
import { dailyPerformance } from "../src/lib/daily-performance";
import {
  rollingPerformance,
  rollingMetrics,
  rollingPerformanceDefaults,
  rollingCurveSegments,
} from "../src/lib/rolling-performance";

const dates = [
  "2024-09-23",
  "2024-09-24",
  "2024-09-25",
  "2024-09-26",
  "2024-09-27",
  "2024-09-30",
  "2024-10-08",
  "2024-10-09",
  "2024-10-10",
  "2024-10-11",
];
const returns = [0.01, -0.02, 0.03, 0, -0.01, 0.02, -0.03, 0.04, 0.01, -0.01];
const input = { dates, tradingDays: dates, returns };

it("window 3 advances one trading day, including weekends and the long holiday", () => {
  const points = rollingPerformance({ ...input, window: 3 });
  // 第 e 个日（1-based）覆盖 [e-2,e]，共3日；10-3+1=8个点。
  expect(points).toHaveLength(8);
  points.forEach((point, i) => {
    expect([point.startDate, point.endDate, point.tradingDays]).toEqual([
      dates[i],
      dates[i + 2],
      3,
    ]);
  });
  expect(points[4]).toMatchObject({
    startDate: "2024-09-27",
    endDate: "2024-10-08",
    tradingDays: 3,
  });
  // 自然日回溯3天只剩10/8；交易日窗还包含9/27、9/30。
  expect(
    dates.filter((date) => date >= "2024-10-05" && date <= "2024-10-08"),
  ).toHaveLength(1);
});

it.each(["compound", "simple"] as const)(
  "all 17 metrics are U1-identical for %s, null differs from wbt zero-fill",
  (basis) => {
    const values = [0.1, null, -0.05, null, 0];
    const point = rollingPerformance({
      dates: dates.slice(0, 5),
      tradingDays: dates,
      returns: values,
      window: 5,
      basis,
      yearlyDays: 250,
      annualRiskFreeRate: 0.03,
    })[0]!;
    const direct = dailyPerformance({
      returns: values,
      basis,
      yearlyDays: 250,
      annualRiskFreeRate: 0.03,
    });
    const removed = dailyPerformance({
      returns: values.filter((r) => r !== null),
      basis,
      yearlyDays: 250,
      annualRiskFreeRate: 0.03,
    });
    expect(rollingMetrics).toHaveLength(17);
    expect(point).toMatchObject(direct);
    for (const [key] of rollingMetrics)
      expect(point[key]).toEqual(removed[key]);
    expect(point.coverage).toEqual({
      observedDays: 5,
      availableDays: 3,
      nullDays: 2,
      zeroReturnDays: 1,
    });
    // wbt 的 NaN -> 0 会把已知3日伪造成5日，改变年化、夏普和胜率。
    const wbtZeroFill = dailyPerformance({
      returns: values.map((r) => r ?? 0),
      basis,
      yearlyDays: 250,
    });
    expect(point.annualReturn).not.toEqual(wbtZeroFill.annualReturn);
    expect(point.sharpeWbt).not.toEqual(wbtZeroFill.sharpeWbt);
    expect(point.dailyWinRate).not.toEqual(wbtZeroFill.dailyWinRate);
    expect(wbtZeroFill.coverage.nullDays).toBe(0);
  },
);

it.each([59, 60, 61])(
  "coverage boundary %i percent still calculates metrics",
  (available) => {
    const calendar = Array.from({ length: 100 }, (_, i) =>
      new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    );
    const point = rollingPerformance({
      dates: calendar,
      tradingDays: calendar,
      returns: calendar.map((_, i) => (i < available ? 0.001 : null)),
      window: 100,
    })[0]!;
    expect(rollingPerformanceDefaults.minimumCoverage).toBe(0.6);
    expect(point.insufficientCoverage).toBe(available < 60);
    expect(point.coverage.availableDays).toBe(available);
    expect(point.totalReturn.value).not.toBeNull();
  },
);

it("missing calendar observations remain null without compressing the window", () => {
  const point = rollingPerformance({
    dates: [dates[0]!, dates[2]!],
    tradingDays: dates,
    returns: [0.1, -0.1],
    window: 3,
  })[0]!;
  expect(point.tradingDays).toBe(3);
  expect(point).toMatchObject(dailyPerformance({ returns: [0.1, null, -0.1] }));
  expect(point.startDate).toBe(dates[0]);
});

it("partial windows report actual size, without padding or extrapolating", () => {
  const points = rollingPerformance({ ...input, window: 5, minPeriods: 2 });
  expect(points.map((p) => p.tradingDays)).toEqual([2, 3, 4, 5, 5, 5, 5, 5, 5]);
  expect(points[0]).toMatchObject(
    dailyPerformance({ returns: returns.slice(0, 2) }),
  );
  expect(points[0]).toMatchObject({ startDate: dates[0], endDate: dates[1] });
  expect(rollingPerformance(input)).toEqual([]);
  expect(
    rollingPerformance({ dates: [], returns: [], tradingDays: [] }),
  ).toEqual([]);
});

it("all-null windows are insufficient and future observations cannot change prior points", () => {
  const empty = rollingPerformance({
    ...input,
    returns: dates.map(() => null),
    window: 3,
  })[0]!;
  expect(empty.insufficientCoverage).toBe(true);
  for (const [key] of rollingMetrics) expect(empty[key].value).toBeNull();
  const short = rollingPerformance({
    ...input,
    dates: dates.slice(0, 6),
    returns: returns.slice(0, 6),
    window: 3,
  });
  expect(rollingPerformance({ ...input, window: 3 }).slice(0, 4)).toEqual(
    short,
  );
});

it("invalid parameters and axes are rejected, even without enough periods", () => {
  for (const window of [0, -1, 1.5, Infinity, NaN])
    expect(() => rollingPerformance({ ...input, window })).toThrow();
  for (const minPeriods of [0, -1, 4, 1.5])
    expect(() =>
      rollingPerformance({ ...input, window: 3, minPeriods }),
    ).toThrow();
  expect(() =>
    rollingPerformance({ ...input, returns: [NaN, ...returns.slice(1)] }),
  ).toThrow();
  expect(() => rollingPerformance({ ...input, yearlyDays: 0 })).toThrow();
  expect(() =>
    rollingPerformance({ ...input, dates: [...dates].reverse() }),
  ).toThrow();
  expect(() =>
    rollingPerformance({ ...input, tradingDays: dates.slice(1) }),
  ).toThrow();
  expect(() => rollingPerformance({ ...input, returns: [] })).toThrow();
});

it("curve projection splits null gaps and retains valid zeros", () => {
  const points = [null, 1, 0, null, 2, null].map((value, i) => ({
    endDate: dates[i]!,
    sharpeWbt: value,
    maxDrawdown: value,
    annualReturn: value,
    insufficientCoverage: false,
  }));
  expect(rollingCurveSegments(points, "sharpeWbt")).toEqual([
    [
      { date: dates[1], value: 1 },
      { date: dates[2], value: 0 },
    ],
    [{ date: dates[4], value: 2 }],
  ]);
});
