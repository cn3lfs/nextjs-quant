import { expect, it } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import { canslimSaucer } from "../src/server/strategies/canslim/canslim-saucer";
const fixture = (): Snapshot => ({
  id: "test",
  symbol: "sh600519",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: Array.from({ length: 51 }, (_, i) => {
    const high =
      i < 20 ? 100 : i < 50 ? 93 + 7 * ((i - 34.5) / 14.5) ** 2 : 103;
    return {
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      high,
      low: high - 1,
      open: high - 0.5,
      close: high - 0.2,
      volume: i < 20 ? 100 : i < 50 ? 30 : 200,
      amount: 1000,
    };
  }),
});
it("recognizes a shallow rounded base and excludes the test day", () => {
  const s = fixture(),
    result = canslimSaucer(s);
  if (!result.applicable) throw new Error("fixture invalid");
  const target = result.candidates.find((c) => c.length === 30);
  expect(target).toMatchObject({
    high: 100,
    rounded: true,
    points: 10,
    qualified: true,
    threeDayHold: null,
  });
  s.bars.at(-1)!.high = 200;
  s.bars.at(-1)!.close = 199;
  const after = canslimSaucer(s);
  expect(after.applicable && after.candidates).toEqual(result.candidates);
});
it("rejects volume expansion and a trough at the edge", () => {
  const s = fixture();
  for (const bar of s.bars.slice(20, 50)) bar.volume = 100;
  const result = canslimSaucer(s);
  expect(
    result.applicable &&
      result.candidates.find((c) => c.length === 30)?.qualified,
  ).toBe(false);
  s.bars[20]!.low = 85;
  const edge = canslimSaucer(s);
  expect(
    edge.applicable && edge.candidates.find((c) => c.length === 30)?.rounded,
  ).toBe(false);
});

it("scores a confirmed W saucer separately from a rounded bottom", () => {
  const s = fixture(),
    knots = [
      [20, 100],
      [28, 94],
      [35, 99],
      [42, 94],
      [49, 100],
    ] as const;
  for (let index = 20; index <= 49; index++) {
    const right = Math.max(
      1,
      knots.findIndex(([i]) => i >= index),
    );
    const a = knots[right - 1]!,
      b = knots[right]!;
    const high = a[1] + ((b[1] - a[1]) * (index - a[0])) / (b[0] - a[0]);
    Object.assign(s.bars[index]!, {
      high,
      low: high - 1,
      open: high - 0.5,
      close: high - 0.2,
    });
  }
  const result = canslimSaucer(s);
  if (!result.applicable) throw new Error("fixture invalid");
  expect(result.candidates.find((c) => c.length === 30)).toMatchObject({
    shape: "W",
    rounded: false,
    points: 9,
    qualified: true,
    doubleBottom: {
      first: s.bars[28]!.date,
      second: s.bars[42]!.date,
      firstConfirmedAt: s.bars[31]!.date,
      secondConfirmedAt: s.bars[45]!.date,
    },
  });
});
