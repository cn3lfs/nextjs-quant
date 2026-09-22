import { expect, it } from "vitest";
import { canslimCup } from "../src/server/strategies/canslim/canslim-cup";
import type { Snapshot } from "../src/lib/domain";
const fixture = (): Snapshot => ({
  id: "cup",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: Array.from({ length: 51 }, (_, i) => {
    const high =
      i < 4
        ? 97 + i
        : i <= 43
          ? 80 + 20 * ((i - 23) / 20) ** 2
          : i < 50
            ? 98
            : 103;
    return {
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      high,
      low: i > 43 && i < 50 ? 95 : high - 1,
      open: high - 0.5,
      close: high - 0.2,
      volume: i <= 43 ? 100 : i < 50 ? 50 - (i - 44) * 5 : 200,
      amount: 1000,
    };
  }),
});
it("records confirmed rims and a rounded cup with a shrinking upper-half handle", () => {
  const s = fixture(),
    result = canslimCup(s);
  expect(result.applicable).toBe(true);
  if (!result.applicable) return;
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    left: s.bars[3]!.date,
    right: s.bars[43]!.date,
    rightConfirmedAt: s.bars[46]!.date,
    handleLength: 6,
    duration: 40,
    qualified: true,
    points: 10,
    threeDayHold: null,
  });
});
it("cannot use the test bar to confirm a rim or turn a deep handle into a valid one", () => {
  const s = fixture();
  s.bars = s.bars.slice(0, 47);
  const early = canslimCup(s);
  expect(early.applicable && early.candidates.length).toBe(0);
  const deep = fixture();
  deep.bars[48]!.low = 80;
  const result = canslimCup(deep);
  expect(result.applicable && result.candidates[0]!.qualified).toBe(false);
});
it("changing the test day does not change cup geometry", () => {
  const s = fixture(),
    before = canslimCup(s);
  s.bars.at(-1)!.high = 200;
  s.bars.at(-1)!.close = 199;
  const after = canslimCup(s);
  if (!before.applicable || !after.applicable)
    throw new Error("fixture invalid");
  expect(after.candidates).toEqual(before.candidates);
});

it("classifies a confirmed double bottom as W with traceable low dates", () => {
  const s = fixture();
  const knots = [
    [3, 100],
    [13, 80],
    [23, 92],
    [33, 80],
    [43, 100],
  ] as const;
  for (let index = 4; index <= 43; index++) {
    const right = knots.findIndex(([i]) => i >= index),
      a = knots[right - 1]!,
      b = knots[right]!;
    const high = a[1] + ((b[1] - a[1]) * (index - a[0])) / (b[0] - a[0]);
    Object.assign(s.bars[index]!, {
      high,
      low: high - 1,
      open: high - 0.5,
      close: high - 0.2,
    });
  }
  const result = canslimCup(s);
  if (!result.applicable) throw new Error("fixture invalid");
  const target = result.candidates.find(
    (c) => c.left === s.bars[3]!.date && c.right === s.bars[43]!.date,
  );
  expect(target).toMatchObject({
    shape: "W",
    points: 9,
    qualified: true,
    doubleBottom: {
      first: s.bars[13]!.date,
      second: s.bars[33]!.date,
      firstConfirmedAt: s.bars[16]!.date,
      secondConfirmedAt: s.bars[36]!.date,
    },
  });
});
it("does not classify a single sharp low as a double bottom", () => {
  const s = fixture();
  for (let index = 4; index <= 43; index++) {
    const high = 80 + Math.abs(index - 23);
    Object.assign(s.bars[index]!, {
      high,
      low: high - 1,
      open: high - 0.5,
      close: high - 0.2,
    });
  }
  const result = canslimCup(s);
  if (!result.applicable) throw new Error("fixture invalid");
  const target = result.candidates.find(
    (c) => c.left === s.bars[3]!.date && c.right === s.bars[43]!.date,
  );
  expect(target?.doubleBottom).toBeNull();
  expect(target?.qualified).toBe(false);
});
