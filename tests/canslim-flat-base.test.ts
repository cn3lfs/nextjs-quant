import { expect, it } from "vitest";
import { canslimFlatBase } from "../src/server/canslim-flat-base";
import type { Snapshot } from "../src/lib/domain";
const fixture = (): Snapshot => ({
  id: "test",
  symbol: "sh600519",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: Array.from({ length: 41 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: 97,
    high: i === 40 ? 103 : 100,
    low: 95,
    close: i === 40 ? 102 : 97,
    volume: i < 20 ? 100 : i < 30 ? 45 : i < 40 ? 35 : 70,
    amount: 1000,
  })),
});
it("excludes the test day from the base and volume references", () => {
  const result = canslimFlatBase(fixture());
  expect(result.applicable).toBe(true);
  if (!result.applicable) return;
  expect(result.candidates.find((c) => c.length === 20)).toMatchObject({
    high: 100,
    points: 10,
    qualified: true,
    breakout: {
      closeAboveConfirmation: true,
      withinFivePercent: true,
      volumeConfirmed: true,
      threeDayHold: null,
    },
  });
});
it("rejects unfinished, malformed and zero-volume bars", () => {
  for (const mutate of [
    (s: Snapshot) => {
      s.period = "5m";
    },
    (s: Snapshot) => {
      s.bars[0]!.volume = 0;
    },
    (s: Snapshot) => {
      s.bars[1]!.date = s.bars[0]!.date;
    },
    (s: Snapshot) => {
      s.bars[0]!.close = 101;
    },
    (s: Snapshot) => {
      s.historicalAsOf = "2025-01-01";
    },
  ]) {
    const s = fixture();
    mutate(s);
    expect(canslimFlatBase(s).applicable).toBe(false);
  }
  const s = fixture();
  expect(
    canslimFlatBase(s, Date.parse(`${s.bars.at(-1)!.date}T15:04:00+08:00`))
      .applicable,
  ).toBe(false);
});

it("enforces strict breakout, inclusive chase limit and real contraction", () => {
  const s = fixture();
  const last = s.bars.at(-1)!;
  const check = () => {
    const result = canslimFlatBase(s);
    if (!result.applicable) throw new Error("fixture invalid");
    return result.candidates.find((c) => c.length === 20)!;
  };
  last.close = 101;
  expect(check().breakout.closeAboveConfirmation).toBe(false);
  last.high = 106;
  last.close = 105;
  expect(check().breakout.withinFivePercent).toBe(true);
  last.close = 105.001;
  expect(check().breakout.withinFivePercent).toBe(false);
  last.volume = 60;
  expect(check().breakout.volumeConfirmed).toBe(true);
  last.volume = 59.99;
  expect(check().breakout.volumeConfirmed).toBe(false);
  for (const bar of s.bars.slice(20, 40)) bar.volume = 40;
  expect(check().qualified).toBe(false);
});
