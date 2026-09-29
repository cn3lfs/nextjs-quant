import { expect, it } from "vitest";
import {
  intradayClocks,
  intradayRange,
  intradayRows,
  liveIntradayDay,
} from "../../../src/lib/chart/intraday";

it("240 A-share minute slots are stamped at each minute's close", () => {
  expect(intradayClocks).toHaveLength(240);
  expect(intradayClocks.slice(0, 2)).toEqual(["09:31", "09:32"]);
  expect(intradayClocks[119]).toBe("11:30");
  expect(intradayClocks[120]).toBe("13:01");
  expect(intradayClocks.at(-1)).toBe("15:00");
});

it("rows carry the cumulative volume-weighted average and minute direction", () => {
  const { rows, whitespace } = intradayRows([
    {
      date: "2026-09-25",
      preClose: 10,
      points: [
        { price: 10.2, volume: 100 },
        { price: 10.1, volume: 300 },
        { price: 10.1, volume: 0 },
      ],
    },
  ]);
  expect(rows.map((r) => [r.clock, r.direction])).toEqual([
    ["09:31", 1],
    ["09:32", -1],
    ["09:33", 0],
  ]);
  expect(rows[1]!.average).toBeCloseTo((10.2 * 100 + 10.1 * 300) / 400, 10);
  expect(rows[2]!.average).toBeCloseTo(rows[1]!.average, 10);
  // Untraded minutes keep the axis spanning the whole session.
  expect(whitespace).toHaveLength(237);
  // Beijing wall time on the UTC axis: 09:31 Beijing → 09:31 UTC seconds.
  expect(rows[0]!.time).toBe(Date.UTC(2026, 8, 25, 9, 31) / 1000);
});

it("multi-day rows reset the average per day and pad only the last day", () => {
  const day = (date: string, preClose: number, price: number) => ({
    date,
    preClose,
    points: Array.from({ length: 240 }, () => ({ price, volume: 1 })),
  });
  const { rows, whitespace } = intradayRows([
    day("2026-09-24", 9, 9.5),
    { ...day("2026-09-25", 9.5, 10), points: [{ price: 10, volume: 5 }] },
  ]);
  expect(rows).toHaveLength(241);
  expect(rows[240]!.average).toBe(10);
  expect(rows[240]!.direction).toBe(1);
  expect(whitespace).toHaveLength(239);
  expect(rows.every((r, i) => i === 0 || r.time > rows[i - 1]!.time)).toBe(
    true,
  );
});

it("price and percent axes are symmetric around the previous close", () => {
  const { rows } = intradayRows([
    {
      date: "2026-09-25",
      preClose: 10,
      points: [
        { price: 10.3, volume: 1 },
        { price: 9.9, volume: 1 },
      ],
    },
  ]);
  const range = intradayRange(rows, 10);
  expect(range.maxValue).toBeCloseTo(10.3, 10);
  expect(range.minValue).toBeCloseTo(9.7, 10);
  expect(range.percent).toBeCloseTo(3, 10);
  // Never narrower than ±1%.
  expect(intradayRange([], 10)).toMatchObject({
    minValue: 9.9,
    maxValue: 10.1,
  });
});

it("the live minutes' day comes from the previous close, not the session clock", () => {
  const bars = [
    { date: "2026-09-22", close: 1250 },
    { date: "2026-09-23", close: 1251.24 },
    { date: "2026-09-24", close: 1237 },
  ];
  // Observed 2026-09-27 (Sunday after the 09-25 Mid-Autumn holiday): the
  // live session is 09-24, whose previous close is 09-23's 1251.24.
  expect(liveIntradayDay(bars, 1251.24, "2026-09-27")).toEqual({
    date: "2026-09-24",
    verified: true,
    previous: 1,
  });
  // Daily bars not yet updated with the live day: today, unverified.
  expect(liveIntradayDay(bars, 1237, "2026-09-28")).toEqual({
    date: "2026-09-28",
    verified: false,
    previous: 2,
  });
  // No matching close (e.g. no quote): unverified, all bars are history.
  expect(liveIntradayDay(bars, null, "2026-09-28")).toMatchObject({
    verified: false,
    previous: 2,
  });
});
