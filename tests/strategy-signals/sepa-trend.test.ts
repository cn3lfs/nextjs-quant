import { expect, it } from "vitest";
import type { Snapshot } from "../../src/lib/domain";
import { sepaTrendFacts } from "../../src/server/strategies/canslim/sepa-trend";
function source(count: number): Snapshot {
  return {
    id: "fixture",
    hash: "fixture",
    createdAt: 0,
    source: "tdx-local",
    symbol: "sh600519",
    period: "day",
    adjustment: "none",
    bars: Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
      open: i + 1,
      close: i + 1,
      high: i + 1,
      low: i + 1,
      volume: 100,
      amount: 100,
    })),
  };
}
it("computes long moving averages and a calendar-based 52-week high without inventing RS", () => {
  const snapshot = source(400);
  const facts = sepaTrendFacts(snapshot);
  expect(facts).toMatchObject({
    ma20: 390.5,
    ma60: 370.5,
    ma120: 340.5,
    ma250: 275.5,
    ma120TwentyBarsAgo: 320.5,
    high52: 400,
    gate: "incomplete",
  });
  expect(Object.values(facts.checks).filter((v) => v === true)).toHaveLength(6);
  expect(facts.checks.relativeStrength85).toBeNull();
  snapshot.bars[0]!.high = 10000;
  expect(sepaTrendFacts(snapshot).high52).toBe(400);
});
it("does not substitute short history or intraday data for daily requirements", () => {
  const short = sepaTrendFacts(source(100));
  expect(short.ma120).toBeNull();
  expect(short.high52).toBeNull();
  expect(short.checks.ma120Rising).toBeNull();
  const minute = sepaTrendFacts({ ...source(400), period: "5m" });
  expect(Object.values(minute.checks).every((v) => v === null)).toBe(true);
});
it("retains failed conditions and includes exactly the 75 percent high boundary", () => {
  const snapshot = source(400);
  snapshot.bars.at(-1)!.close = 300;
  expect(sepaTrendFacts(snapshot).checks.within25PercentOf52WeekHigh).toBe(
    true,
  );
  snapshot.bars.at(-1)!.close = 299.99;
  const facts = sepaTrendFacts(snapshot);
  expect(facts.checks.within25PercentOf52WeekHigh).toBe(false);
  expect(facts.gate).toBe("failed");
});
