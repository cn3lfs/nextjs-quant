import { expect, it } from "vitest";
import type { Snapshot } from "~/lib/domain";
import { weeklyBars } from "~/server/market/weekly-bars";
const days = [
  "2026-08-31",
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
];
const calendar = { days, source: "fixture", hash: "fixture-hash" };
const now = Date.parse("2026-09-04T15:05:00+08:00");
const source = (): Snapshot => ({
  id: "day-fixture",
  hash: "unused",
  symbol: "sh600519",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 1,
  bars: days.map((date, i) => ({
    date,
    open: 10 + i,
    high: 16,
    low: 9,
    close: 11 + i,
    volume: i + 1,
    amount: 100,
  })),
});
it("aggregates a cross-month week at the completed cutoff without mutating inputs", () => {
  const snapshot = source(),
    before = structuredClone(snapshot);
  expect(weeklyBars(snapshot, calendar, now).bars).toEqual([
    {
      date: "2026-09-04",
      open: 10,
      high: 16,
      low: 9,
      close: 15,
      volume: 15,
      amount: 500,
    },
  ]);
  expect(snapshot).toEqual(before);
  expect(weeklyBars(snapshot, calendar, now - 1).excluded[0]!.reason).toBe(
    "unfinished",
  );
  expect(
    weeklyBars({ ...snapshot, historicalAsOf: "2026-09-03" }, calendar, now)
      .bars,
  ).toEqual([]);
});
it("distinguishes missing source days, unknown calendar days and confirmed holidays", () => {
  const snapshot = source();
  snapshot.bars.splice(2, 1);
  expect(weeklyBars(snapshot, calendar, now).excluded[0]!.reason).toBe(
    "missing-days",
  );
  const holiday = { ...calendar, days: days.filter((_, i) => i !== 2) };
  expect(weeklyBars(snapshot, holiday, now).excluded[0]!.reason).toBe(
    "calendar-unknown",
  );
  const confirmed = { ...holiday, closedDays: [days[2]!] };
  expect(weeklyBars(snapshot, confirmed, now).bars).toHaveLength(1);
  expect(weeklyBars(source(), confirmed, now).excluded[0]!.reason).toBe(
    "calendar-conflict",
  );
  expect(() =>
    weeklyBars(source(), { ...calendar, closedDays: [days[0]!] }, now),
  ).toThrow();
});
it("hashes actual reference contents and rejects invalid source values", () => {
  const initial = weeklyBars(source(), calendar, now);
  expect(
    weeklyBars(source(), { ...calendar, days: days.slice(1) }, now).hash,
  ).not.toBe(initial.hash);
  const snapshot = source();
  snapshot.bars[1]!.date = "2026-02-30";
  expect(() => weeklyBars(snapshot, calendar, now)).toThrow();
  expect(
    weeklyBars(source(), { ...calendar, hash: null }, now).bars,
  ).toHaveLength(0);
});
