import { expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import { candlePatterns } from "../../../src/lib/indicators";
import { breakoutPatterns } from "trading-strategies/research/breakout/breakout";
import {
  candleStrategyIds,
  researchCandleSeries,
  type CandleStrategyId,
} from "trading-strategies/research/technical/research-candles";
function fixture(id: CandleStrategyId): Bar[] {
  const bars = Array.from({ length: 102 }, (_, i) => {
    const close = i >= 61 && i <= 81 ? 80 + (i - 61) : 100;
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      close,
      high: close + 1,
      low: close - 1,
      volume: 10000,
      amount: close * 10000,
    };
  });
  const put = (
    i: number,
    open: number,
    close: number,
    high = Math.max(open, close) + 1,
    low = Math.min(open, close) - 1,
  ) => Object.assign(bars[i]!, { open, close, high, low });
  for (let i = 85; i < 90; i++) put(i, 113 - (i - 85) * 2, 112 - (i - 85) * 2);
  if (id.includes("hammer") || id.includes("shooting"))
    put(90, 101, 102, 102.1, 98);
  else if (id.includes("engulf")) {
    put(89, 104, 100);
    put(90, 99, 105);
  } else if (id.includes("star") || id.includes("morning")) {
    put(88, 106, 100);
    put(89, 98, id.includes("doji") ? 98 : 98.2, 98.5, 97.5);
    put(90, 99, 105);
  } else put(90, 100, 100, 101, 99);
  if (id.endsWith("-exit")) {
    for (let i = 85; i <= 90; i++) {
      const b = bars[i]!;
      Object.assign(b, {
        open: 200 - b.open,
        close: 200 - b.close,
        high: 200 - b.low,
        low: 200 - b.high,
      });
    }
    if (id.includes("dark-cloud")) {
      put(89, 96, 102, 103, 95);
      put(90, 104, 98, 105, 97);
    }
    put(91, 100, 101);
  } else {
    for (let i = 91; i < 96; i++)
      put(i, 102 + (i - 91) * 2, 103 + (i - 91) * 2);
    put(96, 112, 112, 113, 111);
    put(97, 110, 109);
  }
  return bars;
}

it("keeps the five legacy diagnostic patterns and distinguishes doji, gaps, shadows and engulfing", () => {
  for (const id of candleStrategyIds) {
    const bars = fixture(id);
    for (const direction of ["long", "short"] as const)
      expect(breakoutPatterns(bars, 90, direction)).toEqual(
        candlePatterns(bars, 90, direction),
      );
  }
  const star = fixture("candle-morning-star");
  expect(researchCandleSeries("candle-morning-doji", star)[90]!.entry).toBe(
    false,
  );
  Object.assign(star[89]!, { open: 100, close: 100, high: 101, low: 99 });
  expect(researchCandleSeries("candle-morning-star", star)[90]!.entry).toBe(
    false,
  );
  const hammer = fixture("candle-hammer");
  hammer[90]!.high = 102.3;
  expect(researchCandleSeries("candle-hammer", hammer)[90]!.entry).toBe(false);
  const engulf = fixture("candle-bull-engulf");
  Object.assign(engulf[90]!, { open: 100, close: 104 });
  expect(researchCandleSeries("candle-bull-engulf", engulf)[90]!.entry).toBe(
    false,
  );
  const cloud = fixture("candle-dark-cloud-exit");
  cloud[90]!.close = 99;
  expect(researchCandleSeries("candle-dark-cloud-exit", cloud)[90]!.exit).toBe(
    false,
  );
});

it("rejects invalid background and does not treat a one-price suspension as a doji", () => {
  for (const mutation of [
    { volume: 0 },
    { volume: NaN },
    { high: NaN },
    { low: 200 },
  ]) {
    const bars = fixture("candle-hammer");
    Object.assign(bars[87]!, mutation);
    expect(researchCandleSeries("candle-hammer", bars)[90]).toMatchObject({
      entry: false,
      exit: false,
      reason: expect.any(String),
    });
  }
  const bars = fixture("candle-bottom-doji");
  Object.assign(bars[90]!, { open: 100, close: 100, high: 100, low: 100 });
  expect(researchCandleSeries("candle-bottom-doji", bars)[90]!.entry).toBe(
    false,
  );
  const rising = fixture("candle-hammer");
  rising[87]!.close = 101;
  rising[87]!.low = 100;
  expect(researchCandleSeries("candle-hammer", rising)[90]!.entry).toBe(false);
});
it.each(candleStrategyIds)(
  "%s calculates causal candle entry and exit",
  (id) => {
    const bars = fixture(id),
      series = researchCandleSeries(id, bars),
      point = series[90]!;
    expect(point.reason).toBeNull();
    expect(id.endsWith("-exit") ? point.exit : point.entry).toBe(true);
    expect(researchCandleSeries(id, bars.slice(0, 91))).toEqual(
      series.slice(0, 91),
    );
  },
);
