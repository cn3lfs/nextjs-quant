import { describe, expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import {
  analyzeBreakout,
  roundStep,
} from "../../../src/server/strategies/breakout/breakout";

describe("breakout round-number ladder", () => {
  it("keeps the A-share ladder and scales outside it", () => {
    expect([5, 50, 500, 1500].map(roundStep)).toEqual([1, 5, 10, 100]);
    expect(roundStep(83000)).toBe(1000);
    expect(roundStep(0.15)).toBe(0.1);
    expect(roundStep(0.000012)).toBe(0.00001);
  });
});

// 120 hourly crypto bars stamped in UTC, as Binance intraday bars are.
const utcBars: Bar[] = Array.from({ length: 120 }, (_, i) => {
  const close = 80000 + Math.sin(i / 6) * 2000 + i * 20;
  return {
    date: new Date(Date.UTC(2026, 0, 1, i + 1)).toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    open: close - 50,
    high: close + 300,
    low: close - 350,
    close,
    volume: 100 + (i % 7) * 10,
    amount: 0,
  } as Bar;
});

describe("breakout on foreign-market chart bars", () => {
  it("breakout accepts UTC-offset intraday dates", () => {
    const result = analyzeBreakout(utcBars, 0, true);
    expect(result.latest?.missing).not.toContain(
      "日线价格/成交量/日期无效或未升序",
    );
  });
});
