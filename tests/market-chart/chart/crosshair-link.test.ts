import { expect, it, vi } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import {
  barInstant,
  createCrosshairLink,
  linkedIndex,
  remapDrawing,
} from "../../../src/lib/chart/crosshair-link";

const bar = (date: string): Bar => ({
  date,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
  amount: 1,
});
// Two trading days of 30-minute bars (8 per day, ending 10:00 … 15:00).
const ends = [
  "10:00",
  "10:30",
  "11:00",
  "11:30",
  "13:30",
  "14:00",
  "14:30",
  "15:00",
];
const minutes = ["2026-09-28", "2026-09-29"].flatMap((d) =>
  ends.map((t) => bar(`${d}T${t}:00+08:00`)),
);
const days = ["2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"].map(bar);

it("maps a 30-minute bar to the day bar of the same trading day", () => {
  const at = barInstant(minutes[9]!.date, "30m"); // 09-29 10:30
  expect(days[linkedIndex(days, "day", at)!]!.date).toBe("2026-09-29");
});

it("maps a day bar to the last 30-minute bar of that day", () => {
  const at = barInstant("2026-09-28", "day");
  expect(minutes[linkedIndex(minutes, "30m", at)!]!.date).toBe(
    "2026-09-28T15:00:00+08:00",
  );
});

it("maps a minute instant to the bar that contains it", () => {
  const at = Date.parse("2026-09-29T10:12:00+08:00");
  expect(minutes[linkedIndex(minutes, "30m", at)!]!.date).toBe(
    "2026-09-29T10:30:00+08:00",
  );
});

it("does not point at another day when this chart has no bar for it", () => {
  expect(linkedIndex(minutes, "30m", barInstant("2026-09-25", "day"))).toBe(
    null,
  );
  expect(linkedIndex(minutes, "30m", barInstant("2026-09-30", "day"))).toBe(
    null,
  );
  expect(
    linkedIndex(days, "day", Date.parse("2026-09-26T10:00:00+08:00")),
  ).toBe(null);
});

it("maps into the week that contains the instant", () => {
  const weeks = ["2026-09-18", "2026-09-25", "2026-09-30"].map(bar);
  const at = barInstant("2026-09-23", "day");
  expect(weeks[linkedIndex(weeks, "week", at)!]!.date).toBe("2026-09-25");
  expect(linkedIndex(weeks, "week", barInstant("2026-01-05", "day"))).toBe(
    null,
  );
});

it("delivers a position to every chart but its sender", () => {
  const link = createCrosshairLink();
  const a = vi.fn(),
    b = vi.fn();
  link.subscribe(a);
  const off = link.subscribe(b);
  link.publish("main", 5);
  expect(a).toHaveBeenCalledWith("main", 5);
  off();
  link.publish("second", null);
  expect(b).toHaveBeenCalledTimes(1);
});

it("places a day drawing on 30-minute bars and skips it outside their data", () => {
  const d = {
    a: { date: "2026-09-28", price: 10, offset: 0.4 },
    b: { date: "2026-09-29", price: 11 },
  };
  expect(remapDrawing(d, "day", minutes, "30m")).toEqual({
    a: { date: "2026-09-28T15:00:00+08:00", price: 10 },
    b: { date: "2026-09-29T15:00:00+08:00", price: 11 },
  });
  expect(
    remapDrawing(
      { ...d, b: { date: "2026-09-30", price: 11 } },
      "day",
      minutes,
      "30m",
    ),
  ).toBe(null);
});
