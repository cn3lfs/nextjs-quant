import { expect, it } from "vitest";
import type { Snapshot } from "~/lib/domain";
import { hourlyBars } from "~/server/hourly-bars";
function source(): Snapshot {
  return {
    id: "minute-fixture",
    hash: "untrusted",
    symbol: "sh600519",
    source: "fixture",
    period: "5m",
    adjustment: "none",
    createdAt: 1,
    bars: [570, 630, 780, 840].flatMap((start) =>
      Array.from({ length: 12 }, (_, i) => {
        const minute = start + (i + 1) * 5;
        return {
          date: `2026-09-08T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00+08:00`,
          open: 10,
          high: 12,
          low: 9,
          close: 11,
          volume: i + 1,
          amount: 100,
        };
      }),
    ),
  };
}
const end = Date.parse("2026-09-08T15:00:00+08:00");
it("aggregates four complete hours without crossing lunch or mutating source", () => {
  const snapshot = source(),
    before = structuredClone(snapshot);
  const result = hourlyBars(snapshot, end);
  expect(result.bars.map((b) => b.date.slice(11, 16))).toEqual([
    "10:30",
    "11:30",
    "14:00",
    "15:00",
  ]);
  expect(result.bars[0]).toMatchObject({
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 78,
    amount: 1200,
  });
  expect(snapshot).toEqual(before);
  snapshot.bars[0]!.volume++;
  expect(hourlyBars(snapshot, end).hash).not.toBe(result.hash);
});
it("excludes incomplete and unfinished hours and honors historical cutoffs", () => {
  const snapshot = source();
  snapshot.bars.splice(3, 1);
  const result = hourlyBars(snapshot, Date.parse("2026-09-08T14:59:59+08:00"));
  expect(result.bars.map((b) => b.date.slice(11, 16))).toEqual([
    "11:30",
    "14:00",
  ]);
  expect(result.excluded.map((e) => e.reason)).toEqual([
    "missing-bars",
    "unfinished",
  ]);
  expect(
    hourlyBars({ ...snapshot, historicalAsOf: "2026-09-07" }, end).bars,
  ).toEqual([]);
});
it("rejects duplicates, non-session timestamps, malformed dates and foreign markets", () => {
  for (const date of [
    "2026-09-08T09:40:00+08:00",
    "2026-09-08T12:00:00+08:00",
    "2026-02-30T09:35:00+08:00",
  ]) {
    const snapshot = source();
    snapshot.bars[0]!.date = date;
    expect(() => hourlyBars(snapshot, end)).toThrow();
  }
  expect(() => hourlyBars({ ...source(), symbol: "usAAPL" }, end)).toThrow();
  expect(() =>
    hourlyBars({ ...source(), historicalAsOf: "2026-02-30" }, end),
  ).toThrow();
});
