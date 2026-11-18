import { expect, it } from "vitest";
import {
  theoryMultiperiodInputs,
  type TheoryMultiperiodSource,
} from "~/server/research/theory-multiperiod-inputs";
const bar = (date: string) => ({
  date,
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 100,
  amount: 1000,
});
const days = [
  "2026-11-09",
  "2026-11-10",
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
];
function source(): TheoryMultiperiodSource {
  return {
    variant: "week-day",
    market: "cn-equity",
    tick: 0.01,
    now: Date.parse("2026-11-13T15:05:00+08:00"),
    calendar: { days, closedDays: [], hash: "calendar" },
    daily: {
      bars: days.map(bar),
      sourceHash: "daily",
      adjustmentId: "forward-fixed-anchor",
    },
  };
}
it("keeps the conservative Friday 15:05 availability boundary", () => {
  const s = source();
  s.now -= 1;
  expect(theoryMultiperiodInputs(s).background.slots).toHaveLength(0);
  s.now += 1;
  expect(theoryMultiperiodInputs(s).background.slots[0]!.bar?.close).toBe(10);
});
it("unknown calendar weekdays invalidate a week instead of pretending holidays", () => {
  const s = source();
  s.calendar.days = days.filter((d) => d !== days[2]);
  const input = theoryMultiperiodInputs(s);
  expect(input.background.slots[0]!.bar).toBeNull();
  expect(input.execution.slots[2]!.reason).toBe("calendar-unknown");
});
it("missing daily input remains an explicit slot and invalidates its week", () => {
  const s = source();
  s.daily.bars = s.daily.bars.filter((b) => b.date !== days[2]);
  const input = theoryMultiperiodInputs(s);
  expect(input.execution.slots[2]!.bar).toBeNull();
  expect(input.background.slots[0]!.bar).toBeNull();
});
it("A-share hourly buckets do not cross lunch and require all twelve bars", () => {
  const s = source();
  s.variant = "day-hour-five";
  const dates = [
    ...Array.from({ length: 24 }, (_, i) => 575 + i * 5),
    ...Array.from({ length: 24 }, (_, i) => 785 + i * 5),
  ].map(
    (m) =>
      `2026-11-13T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
  );
  s.fiveMinute = {
    bars: dates.map(bar),
    sourceHash: "five",
    adjustmentId: s.daily.adjustmentId,
  };
  let input = theoryMultiperiodInputs(s);
  expect(input.setup.slots).toHaveLength(4);
  expect(input.setup.slots.every((v) => v.bar?.volume === 1200)).toBe(true);
  s.fiveMinute.bars.splice(25, 1);
  input = theoryMultiperiodInputs(s);
  expect(input.setup.slots[2]!.bar).toBeNull();
  expect(input.setup.slots[3]!.bar).not.toBeNull();
  expect(input.execution.slots[25]!.bar).toBeNull();
});
it("crypto week is available only at the next UTC Monday", () => {
  const s = source();
  s.market = "crypto";
  s.daily.bars = Array.from({ length: 7 }, (_, i) =>
    bar(
      new Date(Date.parse(days[0]!) + i * 86400000).toISOString().slice(0, 10),
    ),
  );
  s.now = Date.parse("2026-11-16T00:00:00Z");
  expect(theoryMultiperiodInputs(s).background.slots[0]!.availableAt).toBe(
    "2026-11-16T00:00:00Z",
  );
  expect(theoryMultiperiodInputs(s).background.slots[0]!.bar?.volume).toBe(700);
  s.now--;
  expect(theoryMultiperiodInputs(s).background.slots).toHaveLength(0);
});
