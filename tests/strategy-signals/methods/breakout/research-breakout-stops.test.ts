import { expect, it } from "vitest";
import { researchBreakoutStopLocation } from "trading-strategies/research/technical/research-breakout-stops";
import type { Level } from "trading-strategies/research/breakout/breakout";
const candle = {
  date: "2024-05-20",
  open: 99,
  close: 105,
  low: 98,
  high: 106,
  volume: 30000,
  amount: 3000000,
};
const previous = { ...candle, date: "2024-05-19", close: 99 };
const level = (
  price: number,
  index: number,
  source: Level["source"] = "platform-high",
  confirmedAt = "2024-05-18",
): Level => ({ price, index, source, confirmedAt });
it("selects only a previously confirmed platform crossed today, preferring recent then higher", () => {
  const levels = [
    level(100, 10),
    level(102, 11),
    level(103, 11),
    level(97, 13),
    level(105, 14),
    level(104, 15, "swing-high"),
    level(104, 16, "platform-high", candle.date),
  ];
  expect(
    researchBreakoutStopLocation("platform-upper", candle, previous, levels),
  ).toEqual({ price: 103, source: "platform-high", confirmedAt: "2024-05-18" });
  expect(
    researchBreakoutStopLocation("platform-upper", candle, previous, [
      level(98, 10, "platform-low"),
      level(104, 10, "swing-high"),
    ]),
  ).toBeNull();
  expect(
    researchBreakoutStopLocation("breakout-candle", candle, previous, levels),
  ).toEqual({ price: 98, source: "breakout-candle", confirmedAt: candle.date });
});
