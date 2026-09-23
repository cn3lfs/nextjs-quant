import { describe, expect, it } from "vitest";
import { completedBar, completedBarFilter } from "../src/completed-bars.js";
import { bigFloor, bpsOf, moneyMul } from "../src/money.js";

describe("trading-strategy-core", () => {
  it("uses one frozen cutoff for completed bars", () => {
    const beforeClose = Date.parse("2026-09-22T06:00:00.000Z");
    const afterClose = Date.parse("2026-09-22T07:10:00.000Z");
    expect(completedBar("2026-09-22", "day", beforeClose)).toBe(false);
    expect(completedBar("2026-09-22", "day", afterClose)).toBe(true);
    expect(
      completedBarFilter("5m", beforeClose)("2026-09-22T06:00:00+00:00"),
    ).toBe(true);
  });

  it("keeps money arithmetic decimal until the public number boundary", () => {
    expect(moneyMul("100.01", 3)).toBe(300.03);
    expect(bpsOf("1000.01", 5)).toBe(0.500005);
    expect(bigFloor("-1.5")).toBe(-2);
  });
});
