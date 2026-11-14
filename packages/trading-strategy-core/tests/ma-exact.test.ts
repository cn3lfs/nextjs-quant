import { expect, it } from "vitest";
import { maSeries, type IndicatorValue } from "../src/indicators.js";

it("keeps exact per-window arithmetic, missing values and overflow without rolling-sum rounding drift", () => {
  const input: IndicatorValue[] = [
    1e16,
    1,
    -1e16,
    3,
    0,
    -2,
    null,
    0.1,
    0.2,
    0.3,
    Number.MAX_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    NaN,
    Infinity,
    -Infinity,
    0,
    -0,
    10,
    ...Array.from({ length: 200 }, (_, i) => Math.sin(i) * 100),
  ];
  const sparse = [1, , 3] as IndicatorValue[];
  const dense = [
    1e16,
    1,
    -1e16,
    Number.MAX_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    0,
    -0,
    ...Array.from({ length: 1000 }, (_, i) => Math.sin(i / 3) * 100 + i / 7),
  ];
  for (const values of [input, sparse, dense]) {
    for (const n of [1, 2, 5, 20, 250]) {
      // Frozen pre-optimization definition: each complete window independently
      // reduces from zero, left to right, then divides by its full length.
      const expected = values.map((_, i) => {
        if (i + 1 < n) return null;
        const window = values.slice(i + 1 - n, i + 1);
        if (window.some((v) => v === null || !Number.isFinite(v))) return null;
        const mean = (window as number[]).reduce((sum, v) => sum + v, 0) / n;
        return Number.isFinite(mean) ? mean : null;
      });
      expect(maSeries(values, n)).toEqual(expected);
    }
  }
  // A rolling sum loses the middle 1 at 1e16 + 1, then produces 0.5 after
  // removing 1e16 and adding 1. The independent final window is (1 + 1)/2 = 1.
  let rolling = 1e16 + 1;
  rolling -= 1e16;
  rolling += 1;
  expect(rolling / 2).toBe(0.5);
  expect(maSeries([1e16, 1, 1], 2)).toEqual([null, 5e15, 1]);
});
