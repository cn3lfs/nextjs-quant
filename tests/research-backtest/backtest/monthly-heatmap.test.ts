import { describe, expect, it } from "vitest";
import {
  computeMonthlyReturnsHeatmap,
  computeTopDrawdownPeriods,
} from "~/lib/backtest/monthly-heatmap";

describe("computeMonthlyReturnsHeatmap", () => {
  it("compounds gains and losses across missing months and carries the last close into the next year", () => {
    const rows = computeMonthlyReturnsHeatmap(
      [
        { date: "2024-01", value: 110 },
        { date: "2024-03", value: 99 },
        { date: "2025-01", value: 118.8 },
      ],
      100,
    );

    expect(rows).toStrictEqual([
      {
        year: 2024,
        months: [
          expect.closeTo(0.1, 10),
          null,
          expect.closeTo(-0.1, 10),
          ...Array<null>(9).fill(null),
        ],
        yearTotal: expect.closeTo(1.1 * 0.9 - 1, 10),
      },
      {
        year: 2025,
        months: [expect.closeTo(0.2, 10), ...Array<null>(11).fill(null)],
        yearTotal: expect.closeTo(0.2, 10),
      },
    ]);
  });

  it("uses the latest valid point in each month for unsorted input", () => {
    const rows = computeMonthlyReturnsHeatmap(
      [
        { date: "2024-03-29", value: 121 },
        { date: "2024-01-31", value: 110 },
        { date: "2024-02-30", value: 200 },
        { date: "2024-01-02", value: 104 },
        { date: "2024-04-01", value: 0 },
        { date: "2024-05-01", value: -1 },
        { date: "2024-06-01", value: NaN },
      ],
      100,
    );

    expect(rows).toStrictEqual([
      {
        year: 2024,
        months: [
          expect.closeTo(0.1, 10),
          null,
          expect.closeTo(0.1, 10),
          ...Array<null>(9).fill(null),
        ],
        yearTotal: expect.closeTo(0.21, 10),
      },
    ]);
  });

  it("returns no rows for an empty curve even with initial equity", () => {
    expect(computeMonthlyReturnsHeatmap([], 100)).toEqual([]);
  });
});

describe("computeTopDrawdownPeriods", () => {
  it("ranks recovered and open drawdowns by depth and counts valid observations", () => {
    const equity = [
      { date: "2024-01-25", value: 144 },
      { date: "2024-01-02", value: 100 },
      { date: "2024-01-03", value: 95 },
      { date: "2024-01-05", value: 87.5 },
      { date: "2024-01-09", value: 100 },
      { date: "2024-01-10", value: 128 },
      { date: "2024-01-11", value: 0 },
      { date: "2024-01-12", value: 64 },
      { date: "2024-01-16", value: 128 },
      { date: "2024-01-17", value: 160 },
      { date: "2024-01-18", value: 150 },
      { date: "2024-01-23", value: 120 },
    ];
    const deepest = {
      peakDate: "2024-01-10",
      troughDate: "2024-01-12",
      recoveryDate: "2024-01-16",
      depth: -0.5,
      bars: 3,
    };
    const open = {
      peakDate: "2024-01-17",
      troughDate: "2024-01-23",
      recoveryDate: null,
      depth: -0.25,
      bars: 3,
    };
    const shallowest = {
      peakDate: "2024-01-02",
      troughDate: "2024-01-05",
      recoveryDate: "2024-01-09",
      depth: -0.125,
      bars: 4,
    };

    expect(computeTopDrawdownPeriods(equity)).toEqual([
      deepest,
      open,
      shallowest,
    ]);
    expect(computeTopDrawdownPeriods(equity, 100, 2)).toEqual([deepest, open]);
  });

  it("returns no periods for an empty curve even with initial equity", () => {
    expect(computeTopDrawdownPeriods([], 100)).toEqual([]);
  });
});
