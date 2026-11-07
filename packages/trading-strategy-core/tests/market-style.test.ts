import { expect, it } from "vitest";
import type { Bar } from "../src/bars.js";
import { calculateFactor, resolveFactor } from "../src/factors/index.js";
const bars: Bar[] = [100, 110, 99, 118.8].map((close, i) => ({
  date: `day-${i}`,
  open: 100,
  high: Math.max(120, close),
  low: 90,
  close,
  volume: 10,
  amount: [100, 200, 400, 800][i]!,
}));
it("computes return risk and amount liquidity from hand calculations, rather than price STD or volume", () => {
  const value = (id: Parameters<typeof calculateFactor>[1]["id"], period = 3) =>
    calculateFactor(bars, { id, parameters: { period } }).values.at(-1);
  // Returns are +10%, -10%, +20%; sample variance is 7/300.
  expect(value("return-volatility")).toBeCloseTo(Math.sqrt(7 / 300) * 100);
  expect(value("downside-deviation")).toBeCloseTo(Math.sqrt(0.01 / 3) * 100);
  expect(value("maximum-return")).toBeCloseTo(20);
  expect(value("minimum-return")).toBeCloseTo(-10);
  expect(value("up-frequency")).toBeCloseTo(200 / 3);
  expect(value("amount-ma")).toBeCloseTo(1400 / 3);
  expect(value("amount-ratio", 2)).toBeCloseTo(800 / 300);
  expect(value("amihud-illiquidity")).toBeCloseTo(
    ((0.1 / 200 + 0.1 / 400 + 0.2 / 800) / 3) * 1e8,
  );
  expect(value("high-distance")).toBeCloseTo(0);
  expect(value("window-drawdown")).toBeCloseTo(10);
  expect(value("short-reversal", 2)).toBeCloseTo(-8);
  expect(calculateFactor(bars, { id: "bar-amplitude" }).values[1]).toBeCloseTo(
    30,
  );
  expect(calculateFactor(bars, { id: "opening-gap" }).values[2]).toBeCloseTo(
    (100 / 110 - 1) * 100,
  );
  const r = [0.1, -0.1, 0.2],
    average = 1 / 15;
  const m2 = r.reduce((s, v) => s + (v - average) ** 2, 0) / 3;
  expect(value("return-skewness")).toBeCloseTo(
    r.reduce((s, v) => s + (v - average) ** 3, 0) / 3 / m2 ** 1.5,
  );
  expect(value("return-kurtosis")).toBeCloseTo(-1.5);
});
it("uses complete windows and rejects undefined moments, invalid amounts and impossible skip parameters", () => {
  expect(
    calculateFactor(bars, {
      id: "return-volatility",
      parameters: { period: 3 },
    }).values.slice(0, 3),
  ).toEqual([null, null, null]);
  const flat = bars.map((b) => ({ ...b, close: 100, amount: 0 }));
  expect(
    calculateFactor(flat, {
      id: "return-volatility",
      parameters: { period: 2 },
    }).values.at(-1),
  ).toBe(0);
  expect(
    calculateFactor(flat, {
      id: "return-skewness",
      parameters: { period: 2 },
    }).values.at(-1),
  ).toBeNull();
  expect(
    calculateFactor(flat, {
      id: "amihud-illiquidity",
      parameters: { period: 2 },
    }).values,
  ).toEqual([null, null, null, null]);
  expect(() =>
    resolveFactor({
      id: "skip-momentum",
      parameters: { period: 20, skip: 20 },
    }),
  ).toThrow("须小于");
  expect(
    calculateFactor(bars, {
      id: "skip-momentum",
      parameters: { period: 3, skip: 1 },
    }).values.at(-1),
  ).toBeCloseTo(-1);
});
