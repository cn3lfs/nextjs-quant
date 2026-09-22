import { expect, it } from "vitest";
import { cashDividendWindow } from "../src/server/backtest/cash-dividend-window";
import type { Snapshot } from "../src/lib/domain";
const source: Snapshot = {
  id: "s",
  symbol: "sh600000",
  source: "tdx-local",
  period: "day",
  adjustment: "none",
  hash: "h",
  createdAt: 1,
  bars: Array.from({ length: 8 }, (_, i) => ({
    date: `2025-01-0${i + 1}`,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  })),
};
it("retains warmup, excludes post-cutoff bars and creates an independent immutable source identity", () => {
  const before = structuredClone(source),
    result = cashDividendWindow(source, "2025-01-04", "2025-01-06", 3);
  expect(result.evaluationStart).toBe(3);
  expect(result.source.bars).toHaveLength(6);
  expect(result.source.id).not.toBe(source.id);
  expect(result.source.hash).not.toBe(source.hash);
  expect(result.source.historicalAsOf).toBe("2025-01-06");
  expect(source).toEqual(before);
  expect(cashDividendWindow(source, "2025-01-04", "2025-01-06", 3)).toEqual(
    result,
  );
});
it("refuses inadequate warmup, invalid intervals and missing end coverage", () => {
  for (const [start, end] of [
    ["2025-01-01", "2025-01-06"],
    ["2025-01-04", "2025-01-09"],
    ["2025-01-06", "2025-01-04"],
    ["2025-02-30", "2025-03-01"],
  ])
    expect(() => cashDividendWindow(source, start!, end!, 3)).toThrow();
});
