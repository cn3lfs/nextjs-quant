import { expect, it } from "vitest";
import { canslimMarket } from "../src/server/canslim-market";
import type { Snapshot } from "../src/lib/domain";
const fixture = (): Snapshot => ({
  id: "market",
  hash: "hash",
  symbol: "sh000300",
  source: "fixture",
  period: "day",
  adjustment: "none",
  createdAt: 0,
  bars: Array.from({ length: 254 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 500,
    low: 1,
    close: 100 + i,
    volume: 100,
    amount: 1000,
  })),
});
it("scores a sustained rising index and keeps its source identity", () => {
  const result = canslimMarket(fixture());
  expect(result.checks[0]).toMatchObject({
    id: "M1",
    status: "computed",
    points: 10,
    rising: true,
    aboveFourDays: true,
  });
  expect(result.checks[1]).toMatchObject({
    id: "M3",
    points: 5,
    distributionDates: [],
  });
  expect(result.snapshotHash).toBe("hash");
});
it("gives the near-average rule priority and treats a fresh breakout separately", () => {
  const s = fixture();
  s.bars.forEach((b) => {
    b.close = 100;
  });
  expect(canslimMarket(s).checks[0]).toMatchObject({
    points: 5,
    rising: false,
  });
  s.bars.at(-1)!.close = 110;
  expect(canslimMarket(s).checks[0]).toMatchObject({
    points: 7,
    aboveFourDays: false,
  });
});
it("records distribution dates and overrides the total tier for recent concentration", () => {
  const s = fixture();
  s.bars.forEach((b) => {
    b.close = 100;
  });
  for (let i = 251; i < 254; i++) {
    s.bars[i]!.close = 350 - i;
    s.bars[i]!.volume = i;
  }
  expect(canslimMarket(s).checks[1]).toMatchObject({
    points: 0,
    recentCount: 3,
    concentrated: true,
  });
  s.bars.at(-1)!.volume = s.bars.at(-2)!.volume;
  expect(canslimMarket(s).checks[1]).toMatchObject({
    points: 5,
    recentCount: 2,
    concentrated: false,
  });
});
it("does not substitute a stock or insufficient history for the market", () => {
  const s = fixture();
  s.symbol = "sh600519";
  expect(canslimMarket(s).checks.every((c) => c.status === "missing")).toBe(
    true,
  );
  s.symbol = "sh000300";
  s.bars = s.bars.slice(-21);
  expect(canslimMarket(s).checks[0]!.status).toBe("missing");
  expect(canslimMarket(s).checks[1]!.status).toBe("computed");
});
