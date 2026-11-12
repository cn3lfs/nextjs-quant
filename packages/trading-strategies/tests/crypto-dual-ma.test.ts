import { describe, it, expect } from "vitest";
import { cryptoDualMa } from "../src/crypto-dual-ma.js";
describe("spot completed-bar SMA", () => {
  it("warms up and rejects invalid inputs", () => {
    expect(cryptoDualMa([1, 2], 2, 3)).toBeNull();
    expect(() => cryptoDualMa([1, 2], 3, 2)).toThrow();
    expect(() => cryptoDualMa([1, NaN, 2, 3], 2, 3)).toThrow();
  });
  it("detects equality then crosses in both directions", () => {
    expect(cryptoDualMa([2, 2, 2, 4], 2, 3)?.signal).toBe("BUY");
    expect(cryptoDualMa([2, 2, 2, 1], 2, 3)?.signal).toBe("SELL");
    expect(cryptoDualMa([2, 2, 2, 2], 2, 3)?.signal).toBe("HOLD");
  });
  it("uses exactly the latest windows", () => {
    const result = cryptoDualMa([100, 2, 2, 2, 4], 2, 3)!;
    expect(result.short).toBe(3);
    expect(result.long).toBeCloseTo(8 / 3);
  });
});
