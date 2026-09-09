import { expect, it } from "vitest";
import { canslimNewHigh } from "../src/server/canslim-new-high";
import type { Snapshot } from "../src/lib/domain";
const fixture = (): Snapshot => ({
  id: "high",
  hash: "hash",
  symbol: "sh600519",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 0,
  bars: Array.from({ length: 365 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 90,
    high: i === 0 ? 200 : 100,
    low: 80,
    close: 95,
    volume: i === 364 ? 150 : 100,
    amount: 1000,
  })),
});
it("uses calendar weeks, excludes the left boundary and keeps tier equalities", () => {
  const s = fixture();
  for (const [close, points] of [
    [89.99, 0],
    [90, 3],
    [94.99, 3],
    [95, 6],
    [99.99, 6],
    [100, 9],
  ]) {
    s.bars.at(-1)!.close = close!;
    expect(canslimNewHigh(s)).toMatchObject({
      status: "computed",
      points,
      high52Weeks: 100,
      windowBars: 364,
    });
  }
  expect(canslimNewHigh(s).breakoutVolumeConfirmed).toBe(true);
});
it("does not replace a full year with a shorter history or unfinished bar", () => {
  const s = fixture();
  s.bars.shift();
  expect(canslimNewHigh(s)).toMatchObject({
    status: "missing",
    points: 0,
    high52Weeks: null,
  });
  const full = fixture();
  expect(
    canslimNewHigh(full, Date.parse(`${full.bars.at(-1)!.date}T15:04:00+08:00`))
      .status,
  ).toBe("missing");
});
