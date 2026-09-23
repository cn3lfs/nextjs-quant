import { expect, it } from "vitest";
import { dailyPerformance } from "../../../src/lib/backtest/daily-performance";
import {
  aSharePeriodTradingDays,
  isoWeek,
  naturalPeriodWinRates,
  periodPerformance,
  periodicReturns,
} from "../../../src/lib/backtest/period-performance";
import {
  pagePeriodicReturns,
  periodPageSchema,
} from "../../../src/server/research/performance/period-performance-service";

// 合成交易日历，明确剔除周末及长假；不冒充真实交易所日历。
const calendar: string[] = [];
for (let t = Date.UTC(2024, 0, 1); calendar.length < 300; t += 86400000) {
  const date = new Date(t),
    day = date.toISOString().slice(0, 10);
  if (
    date.getUTCDay() !== 0 &&
    date.getUTCDay() !== 6 &&
    !(day >= "2024-10-01" && day <= "2024-10-07") &&
    day !== "2025-01-01"
  )
    calendar.push(day);
}
const returns = calendar.map((_, i) => (i % 3 === 0 ? -0.01 : 0.02));

it.each([
  ["2021-01-01", [2020, 53]],
  ["2026-01-01", [2026, 1]],
  ["2026-12-31", [2026, 53]],
])("ISO Thursday ownership %s", (date, expected) => {
  expect(isoWeek(date as string)).toEqual(expected);
});

it.each(["compound", "simple"] as const)(
  "all eight windows delegate all 17 U1 metrics exactly (%s)",
  (basis) => {
    expect(calendar).toHaveLength(300);
    expect(aSharePeriodTradingDays).toEqual({
      past1w: 5,
      past2w: 10,
      past1m: 20,
      past3m: 60,
      past6m: 120,
      past1y: 250,
    });
    const result = periodPerformance({
      dates: calendar,
      tradingDays: calendar,
      returns,
      basis,
      yearlyDays: 250,
    });
    expect(result).toHaveLength(8);
    const offsets = [
      295,
      290,
      280,
      240,
      180,
      50,
      calendar.findIndex((d) => d >= "2025-01-01"),
      0,
    ];
    result.forEach((row, i) => {
      const offset = offsets[i]!;
      expect(row.startDate).toBe(calendar[offset]);
      expect(row.endDate).toBe(calendar[299]);
      expect(row.tradingDays).toBe(300 - offset);
      expect(row.truncated).toBe(false);
      const direct = dailyPerformance({
        returns: returns.slice(offset),
        basis,
        yearlyDays: 250,
      });
      expect(
        Object.keys(direct).filter(
          (key) =>
            !["basis", "yearlyDays", "annualRiskFreeRate", "coverage"].includes(
              key,
            ),
        ),
      ).toHaveLength(17);
      for (const key of Object.keys(direct) as (keyof typeof direct)[])
        expect(row[key]).toEqual(direct[key]);
    });
  },
);

it.each([
  ["2024-10-08", "2024-09-25"], // 9/25,26,27,30,10/8：跨周末和七天长假
  ["2025-01-03", "2024-12-27"], // 12/27,30,31,1/2,3：跨周末和元旦
])("trading-day boundary ending %s", (end, start) => {
  const dates = calendar.filter((d) => d <= end);
  expect(
    periodPerformance({
      dates,
      returns: dates.map(() => 0.01),
      tradingDays: calendar,
    })[0],
  ).toMatchObject({
    startDate: start,
    endDate: end,
    tradingDays: 5,
    truncated: false,
  });
});

it("YTD aligns to first trading day and flags short available samples", () => {
  const dates = calendar.filter((d) => d <= "2025-01-03");
  const row = periodPerformance({
    dates,
    returns: dates.map(() => 0),
    tradingDays: calendar,
  })[6]!;
  expect(row).toMatchObject({
    startDate: "2025-01-02",
    endDate: "2025-01-03",
    tradingDays: 2,
    truncated: false,
    insufficientSample: true,
  });
  const short = periodPerformance({
    dates: ["2025-01-03"],
    returns: [0],
    tradingDays: calendar,
  });
  expect(short[6]).toMatchObject({
    startDate: "2025-01-03",
    tradingDays: 1,
    truncated: true,
  });
});

it("matrix propagates null per window, counts zero as available but not profitable, and flags 360-day truncation", () => {
  const dates = calendar.slice(0, 3);
  const input = {
    dates,
    tradingDays: calendar,
    series: {
      gain: [0.1, 0.1, 0.1],
      loss: [-0.1, -0.1, -0.1],
      flat: [0, 0, 0],
      gap: [null, 0.1, 0.1],
    },
  };
  const matrix = periodicReturns(input);
  expect(matrix.rows[3]!.cells[0]!.value).toBeCloseTo(0.1);
  expect(matrix.rows[3]!.cells[1]).toMatchObject({
    value: null,
    reason: "窗口内存在缺失日收益",
  });
  expect(matrix.summary[0]).toMatchObject({
    profitable: 2,
    available: 4,
    ratio: 0.5,
  });
  expect(matrix.summary[1]).toMatchObject({
    profitable: 1,
    available: 3,
    ratio: 1 / 3,
  });
  expect(matrix.rows[0]!.cells[1]!.value).toBeCloseTo(1.1 ** 3 - 1);
  expect(
    periodicReturns({ ...input, basis: "simple" }).rows[0]!.cells[1]!.value,
  ).toBeCloseTo(0.3);
  expect(matrix.rows[0]!.cells[11]).toMatchObject({
    window: 360,
    truncated: true,
    tradingDays: 3,
    startDate: dates[0],
    endDate: dates[2],
  });
  const long = periodicReturns({
    dates: calendar,
    tradingDays: calendar,
    series: { stock: returns },
  });
  expect(long.rows[0]!.cells[11]).toMatchObject({
    truncated: true,
    tradingDays: 300,
  });
  expect(
    periodicReturns({
      dates,
      tradingDays: calendar,
      series: { gap: [null, null, null] },
    }).summary[0],
  ).toMatchObject({
    available: 0,
    profitable: 0,
    ratio: null,
    reason: "无可得标的",
  });
});

it("missing axis days remain null; invalid, unordered and mismatched inputs are rejected", () => {
  const dates = calendar.slice(0, 3);
  const input = {
    dates: [dates[0]!, dates[2]!],
    returns: [0.1, 0.1],
    tradingDays: dates,
  };
  expect(periodPerformance(input)[0]!.coverage).toMatchObject({
    observedDays: 3,
    availableDays: 2,
    nullDays: 1,
  });
  expect(
    periodicReturns({ ...input, series: { a: input.returns } }).rows[0]!
      .cells[1]!.value,
  ).toBeNull();
  expect(() => periodPerformance({ ...input, returns: [0] })).toThrow("长度");
  expect(() =>
    periodPerformance({ ...input, dates: ["2024-02-30", dates[2]!] }),
  ).toThrow("日期");
  expect(() =>
    periodPerformance({ ...input, dates: [...input.dates].reverse() }),
  ).toThrow("升序");
  expect(() =>
    periodPerformance({ ...input, tradingDays: [dates[0]!] }),
  ).toThrow("日历");
  expect(() => periodPerformance({ ...input, returns: [NaN, 0] })).toThrow(
    "有限数",
  );
  const empty = periodPerformance({
    dates: [],
    returns: [],
    tradingDays: calendar,
  });
  expect(empty[0]).toMatchObject({
    startDate: null,
    endDate: null,
    tradingDays: 0,
    truncated: true,
    insufficientSample: true,
  });
});

it("natural wins use sums, exclude null periods, and preserve ISO cross-year grouping", () => {
  const dates = [
    "2020-12-31",
    "2021-01-01",
    "2021-01-04",
    "2021-02-01",
    "2021-04-01",
  ];
  const rows = naturalPeriodWinRates({
    dates,
    tradingDays: dates,
    returns: [0.5, -0.4, 0, null, 0.1],
  });
  // 2020-W53 的和为 +0.1，即使复利为 -0.1 也算自然周期盈利。
  expect(rows[0]).toMatchObject({
    periods: 4,
    available: 3,
    profitable: 2,
    value: 2 / 3,
  });
  expect(rows[1]).toMatchObject({
    periods: 4,
    available: 3,
    profitable: 2,
    value: 2 / 3,
  });
  expect(rows[2]).toMatchObject({
    periods: 3,
    available: 2,
    profitable: 2,
    value: 1,
  });
  expect(rows[3]).toMatchObject({
    periods: 2,
    available: 1,
    profitable: 1,
    value: 1,
  });
});

it("server pages sort before slicing and retain full-population summaries", () => {
  const dates = calendar.slice(0, 5);
  const matrix = periodicReturns({
    dates,
    tradingDays: dates,
    series: Object.fromEntries(
      Array.from({ length: 123 }, (_, i) => [
        `S${String(i).padStart(3, "0")}`,
        dates.map(() => (i === 122 ? null : i / 10000)),
      ]),
    ),
  });
  const page = periodPageSchema.parse({
    pageIndex: 1,
    pageSize: 10,
    sort: "5",
    desc: true,
  });
  expect(pagePeriodicReturns(matrix, page).rows.map((r) => r.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => `S${111 - i}`),
  );
  expect(pagePeriodicReturns(matrix, page)).toMatchObject({
    rowCount: 123,
    summary: matrix.summary,
  });
  expect(
    pagePeriodicReturns(matrix, { ...page, pageIndex: 12 }).rows.at(-1)!.id,
  ).toBe("S122");
  expect(pagePeriodicReturns(matrix, { ...page, pageIndex: 20 }).rows).toEqual(
    [],
  );
  for (const invalid of [
    { pageSize: 0 },
    { pageSize: 101 },
    { pageIndex: -1 },
    { sort: "invalid" },
  ])
    expect(periodPageSchema.safeParse(invalid).success).toBe(false);
});
