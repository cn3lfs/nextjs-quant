import { expect, it } from "vitest";
import {
  createPerformanceReport,
  queryPerformanceReport,
} from "../src/index.js";

const points = [
  { date: "2024-12-31", value: 0.9, benchmarkReturn: -0.05 },
  { date: "2025-01-02", value: 0.99, benchmarkReturn: 0.02 },
  { date: "2025-04-01", value: 1.1, benchmarkReturn: 0.03 },
];
it("works with unitized account NAV, does not mutate inputs and exports independent observations", () => {
  const original = structuredClone(points);
  const report = createPerformanceReport(1, points);
  expect(report.overview.totalReturn.value).toBeCloseTo(0.1);
  expect(report.month).toHaveLength(3);
  expect(report.quarter).toHaveLength(3);
  report.daily[0]!.value = 100;
  expect(points).toEqual(original);
});
it("selects periods through the module contract and cannot leak another year's or frequency's selection", () => {
  for (const frequency of ["year", "quarter", "month"] as const) {
    const page = queryPerformanceReport(1, points, { frequency });
    expect(page.years).toEqual([2025, 2024]);
    expect(page.year).toBe(2025);
    expect(page.periods.every((p) => p.year === 2025)).toBe(true);
    expect(page.months.map((p) => p.key)).toEqual(["2025-01", "2025-04"]);
    expect(page.selected).toBeNull();
    expect(
      queryPerformanceReport(1, points, {
        frequency,
        period: page.periods[0]!.key,
      }).selected?.key,
    ).toBe(page.periods[0]!.key);
  }
  expect(() =>
    queryPerformanceReport(1, points, {
      frequency: "month",
      year: 2025,
      period: "2024-12",
    }),
  ).toThrow("期间");
  expect(() =>
    queryPerformanceReport(1, points, { frequency: "month", year: 2020 }),
  ).toThrow("年份");
  const empty = queryPerformanceReport(1, [], { frequency: "year" });
  expect(empty).toMatchObject({
    year: null,
    years: [],
    periods: [],
    months: [],
    selected: null,
  });
});
