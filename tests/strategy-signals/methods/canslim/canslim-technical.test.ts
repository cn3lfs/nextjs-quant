import { expect, it } from "vitest";
import { canslimTechnical } from "../../../../src/server/strategies/canslim/canslim-technical";
import type { Snapshot } from "../../../../src/lib/domain";

it("joins qualified geometry to its own pivot without inventing market evidence", () => {
  const snapshot: Snapshot = {
    id: "technical",
    hash: "source-hash",
    source: "fixture",
    symbol: "sh600519",
    period: "day",
    adjustment: "none",
    createdAt: 0,
    bars: Array.from({ length: 51 }, (_, i) => ({
      date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
      open: 99,
      high: i === 50 ? 103 : 100,
      low: 95,
      close: i === 50 ? 102 : 99,
      volume: i < 20 ? 1000 : i < 35 ? 400 : i < 50 ? 200 : 1500,
      amount: 1000,
    })),
  };
  const result = canslimTechnical(snapshot, Date.parse("2025-03-01T00:00:00Z"));
  expect(result.snapshotHash).toBe("source-hash");
  expect(result.entries.length).toBeGreaterThan(0);
  for (const item of result.entries) {
    expect(item.entry.pivot).toBe(100);
    expect(item.entry.strength).toBe("missing");
    expect(item.entry.checks.marketConfirmed).toBeNull();
    expect(item.entry.checks.catalystConfirmed).toBeNull();
  }
  const market = {
    ...snapshot,
    symbol: "sh000300",
    id: "index",
    hash: "index-hash",
    bars: snapshot.bars.map((b) => ({ ...b })),
  };
  const aligned = canslimTechnical(
    snapshot,
    Date.parse("2025-03-01T00:00:00Z"),
    market,
  );
  expect(aligned.marketContext?.snapshotHash).toBe("index-hash");
  expect(aligned.missing).not.toContain("同日沪深300涨跌幅证据");
  expect(
    aligned.entries.every((item) => item.entry.checks.marketConfirmed === true),
  ).toBe(true);
  expect(
    aligned.entries.every((item) => item.entry.strength === "strong"),
  ).toBe(true);
  market.bars.at(-2)!.date = "2025-02-18";
  expect(
    canslimTechnical(snapshot, Date.parse("2025-03-01T00:00:00Z"), market)
      .marketContext,
  ).toBeNull();
  expect(
    canslimTechnical(snapshot, Date.parse("2025-03-01T00:00:00Z"), {
      ...market,
      symbol: "sh000001",
    }).marketContext,
  ).toBeNull();
  snapshot.bars[0]!.volume = 0;
  expect(canslimTechnical(snapshot).entries).toEqual([]);
});
