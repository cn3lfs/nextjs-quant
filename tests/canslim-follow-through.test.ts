import { expect, it } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import { canslimFollowThrough } from "../src/server/canslim-follow-through";
const fixture = (): Snapshot => ({
  id: "follow",
  hash: "hash",
  symbol: "sh000300",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 0,
  bars: Array.from({ length: 38 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: i === 30 ? 90 : i > 30 ? 95 : 99,
    close: i === 30 ? 99 : i < 34 ? 100 : 102,
    volume: i === 34 ? 151 : 100,
    amount: 1000,
  })),
});
it("confirms fourth-day price and strict volume conditions and retains dates", () => {
  const s = fixture();
  expect(canslimFollowThrough(s)).toMatchObject({
    status: "computed",
    points: 8,
    selectedDate: s.bars[34]!.date,
  });
  expect(canslimFollowThrough(s).candidates[0]).toMatchObject({
    reboundDay: 4,
    bottomDate: s.bars[30]!.date,
    reboundStart: s.bars[31]!.date,
  });
  s.bars[34]!.volume = 150;
  expect(canslimFollowThrough(s).points).toBe(4);
});
it("invalidates a later low break but allows equality", () => {
  const s = fixture();
  expect(canslimFollowThrough(s).points).toBe(8);
  s.bars[37]!.low = 94;
  expect(canslimFollowThrough(s)).toMatchObject({ points: 0 });
  expect(canslimFollowThrough(s).candidates[0]!.invalidatedAt).toBe(
    s.bars[37]!.date,
  );
});
it("does not confirm out-of-window volume spikes or missing input", () => {
  const s = fixture();
  s.bars[34]!.volume = 100;
  s.bars[34]!.close = 100;
  s.bars[33]!.volume = 200;
  expect(
    canslimFollowThrough(s).candidates.every(
      (c) => c.date !== s.bars[33]!.date,
    ),
  ).toBe(true);
  s.symbol = "sh600519";
  expect(canslimFollowThrough(s).status).toBe("missing");
});
