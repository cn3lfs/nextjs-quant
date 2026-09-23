import { expect, it } from "vitest";
import {
  clsOutcomes,
  clsOutcomeStatistics,
} from "../../src/server/news/cls-outcomes";
import type { ClsSample } from "../../src/server/news/cls-sample";

const dates = [
  "2026-09-11",
  "2026-09-14",
  "2026-09-15",
  "2026-09-16",
  "2026-09-17",
  "2026-09-18",
];
const bars = dates.map((date) => ({
  date,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 100,
  amount: 1000,
}));
const sample: ClsSample = {
  version: "cls-sample-1",
  date: dates[0]!,
  fixedAt: Date.parse("2026-09-11T09:00:00+08:00"),
  reportId: "report",
  reportHash: "hash",
  previousTradingDay: "2026-09-10",
  calendarSource: "fixture",
  poolHash: "pool",
  candidates: [],
  selected: {
    symbol: "sh600000",
    sectionId: "section",
    direction: "bullish",
    priority: 0,
    basis: "sector-rps",
    rps: 95,
    evidence: "fixture",
  },
  reason: null,
};

it("keeps incomplete horizons out of hit rates and uses sample-day open for follow-ups", () => {
  const now = Date.parse("2026-09-14T15:10:00+08:00");
  const outcomes = clsOutcomes(
    sample,
    bars,
    bars.map((bar) => ({ ...bar, close: 10.5 })),
    dates,
    now,
  );
  expect(outcomes.map((row) => row.status)).toEqual([
    "observed",
    "observed",
    "pending",
    "pending",
  ]);
  expect(outcomes[1]?.grossReturn).toBeCloseTo(0.1);
  expect(outcomes[1]?.excessReturn).toBeCloseTo(0.05);
  expect(clsOutcomeStatistics(outcomes, 1)).toMatchObject({
    valid: 1,
    hitRate: 1,
  });
  expect(clsOutcomeStatistics(outcomes, 5)).toMatchObject({
    valid: 0,
    pending: 1,
    hitRate: null,
  });
  expect(
    clsOutcomes(
      sample,
      bars,
      bars,
      dates,
      Date.parse("2026-09-11T14:55:00+08:00"),
    )[0]?.status,
  ).toBe("pending");
});

it("separates missing prices, flat observations, bearish hits and hindsight records", () => {
  const now = Date.parse("2026-09-18T15:10:00+08:00");
  expect(clsOutcomes(sample, bars.slice(1), bars, dates, now)[0]).toMatchObject(
    { status: "unavailable", hit: null, grossReturn: null },
  );
  expect(
    clsOutcomes(
      sample,
      bars.map((bar) => ({ ...bar, close: 10 })),
      [],
      dates,
      now,
    )[0],
  ).toMatchObject({ status: "observed", hit: false, benchmarkReturn: null });
  expect(
    clsOutcomes(
      { ...sample, selected: { ...sample.selected!, direction: "bearish" } },
      bars.map((bar) => ({ ...bar, close: 9 })),
      bars,
      dates,
      now,
    )[0]?.hit,
  ).toBe(true);
  expect(
    clsOutcomes({ ...sample, fixedAt: now }, bars, bars, dates, now)[0]?.status,
  ).toBe("unavailable");
});
