import { researchCanslimWeekly } from "trading-strategies/research/canslim/research-canslim-weekly";
import { researchCanslimPriorityPoint } from "trading-strategies/research/canslim/research-canslim-priority";

import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";

function weekdays(count: number) {
  return Array.from(
    { length: count * 2 },
    (_, i) => new Date(Date.UTC(2024, 0, i + 1)),
  )
    .filter((d) => d.getUTCDay() > 0 && d.getUTCDay() < 6)
    .slice(0, count)
    .map((d) => d.toISOString().slice(0, 10));
}

function price(bars: Bar[], index: number, close: number) {
  Object.assign(bars[index]!, {
    open: close,
    close,
    high: close + 1,
    low: close - 1,
  });
}
function simple() {
  return weekdays(75).map((date) => ({
    date,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
}
const empty = researchCanslimPriorityPoint([]);
function weekly(bars: Bar[], calendar = bars.map((b) => b.date)) {
  return researchCanslimWeekly(
    bars.map((b) => ({ ...empty, date: b.date })),
    bars,
    calendar,
  );
}

it("requires completed 10-week and previous averages, crossing rather than continued weakness", () => {
  const bars = simple();
  price(bars, 54, 90);
  price(bars, 59, 89);
  price(bars, 64, 110);
  price(bars, 69, 90);
  const points = weekly(bars);
  const signals = points.filter((p) => p.weeklyReduction?.triggered);
  expect(signals.map((p) => p.date)).toEqual([bars[54]!.date, bars[69]!.date]);
  expect(signals[0]!.weeklyReduction).toMatchObject({
    average: 99,
    previousAverage: 100,
    previousClose: 100,
    close: 90,
    fraction: 0.5,
  });
  expect(weekly(bars.slice(0, 54))).toEqual(points.slice(0, 54));
  expect(weekly(bars.slice(0, 55))).toEqual(points.slice(0, 55));
  expect(points[49]!.weeklyReduction!.triggered).toBe(false);
});

it("does not use a still-forming week or treat equality as a downcross", () => {
  const bars = simple();
  price(bars, 50, 80);
  expect(weekly(bars).some((p) => p.weeklyReduction?.triggered)).toBe(false);
  price(bars, 54, 100);
  expect(weekly(bars)[54]!.weeklyReduction).toMatchObject({
    average: 100,
    close: 100,
    triggered: false,
  });
  price(bars, 54, 99.999);
  expect(weekly(bars)[54]!.weeklyReduction!.triggered).toBe(true);
});

it("confirms a holiday short week only after its natural end and refuses stock-specific missing days", () => {
  const bars = simple();
  price(bars, 53, 90);
  const originalCalendar = bars.map((b) => b.date);
  const holiday = bars.filter((_, i) => i !== 54);
  const signals = weekly(holiday).filter((p) => p.weeklyReduction?.triggered);
  expect(signals[0]!.date).toBe(bars[55]!.date);
  expect(signals[0]!.weeklyReduction).toMatchObject({
    closeDate: bars[53]!.date,
    completedAt: bars[54]!.date,
    confirmedDate: bars[55]!.date,
  });
  expect(
    weekly(holiday.slice(0, 54)).some((p) => p.weeklyReduction?.triggered),
  ).toBe(false);
  expect(
    weekly(holiday, originalCalendar).some((p) => p.weeklyReduction?.triggered),
  ).toBe(false);
  const invalid = structuredClone(bars);
  invalid[52]!.volume = 0;
  price(invalid, 54, 90);
  expect(weekly(invalid)[54]!.weeklyReduction!.close).toBeNull();
  const clipped = bars.slice(1);
  price(clipped, 53, 90);
  expect(
    weekly(clipped).find((p) => p.date === bars[54]!.date)!.weeklyReduction!
      .triggered,
  ).toBe(false);
});
