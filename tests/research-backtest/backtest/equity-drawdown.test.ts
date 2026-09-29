import { describe, expect, it } from "vitest";
import { drawdownCurve, returnCurve } from "~/lib/backtest/equity-drawdown";

describe("drawdownCurve", () => {
  it("measures percent below the running peak", () => {
    const rows = drawdownCurve([
      { date: "2024-01-02", value: 100 },
      { date: "2024-01-03", value: 120 },
      { date: "2024-01-04", value: 90 },
      { date: "2024-01-05", value: 130 },
    ]);
    expect(rows.map((r) => r.value)).toEqual([0, 0, -25, 0]);
    expect(rows[2]!.date).toBe("2024-01-04");
  });
});

describe("returnCurve", () => {
  it("rebases a curve to percent return over its first point", () => {
    expect(
      returnCurve([
        { date: "a", value: 200 },
        { date: "b", value: 250 },
        { date: "c", value: 150 },
      ]).map((r) => r.value),
    ).toEqual([0, 25, -25]);
  });
});
