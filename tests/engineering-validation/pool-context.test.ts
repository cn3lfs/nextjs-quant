import { expect, it } from "vitest";
import {
  summarizePool,
  type PoolObservation,
} from "../../src/server/market/pool-context";
import { defaultStrategy, type Metrics } from "../../src/lib/domain";
const row = (
  symbol: string,
  change: number,
  close: number,
): PoolObservation => ({
  symbol,
  amount: 1000,
  hash: symbol,
  metrics: { change, close, fast: 10, slow: 9 } as Metrics,
});
it("summarizes all eligible pool records, preserves period units, and hashes deterministically", () => {
  const rows = [
    row("sh600001", 2, 11),
    row("sh600002", -1, 9),
    row("sh600003", 0, 10),
  ];
  const symbols = [...rows.map((item) => item.symbol), "sh600004"];
  const result = summarizePool(
    symbols,
    rows,
    "2025-01-01T10:00:00+08:00",
    "5m",
    defaultStrategy,
  );
  expect(result).toMatchObject({
    requested: 4,
    observed: 3,
    up: 1,
    down: 1,
    flat: 1,
    aboveFast: 1,
    aboveSlow: 2,
    medianChange: 0,
    amount: 3000,
    period: "5m",
    scope: "submitted-universe",
  });
  expect(result.meanChange).toBeCloseTo(1 / 3);
  expect(result.observationHash).not.toBe(
    summarizePool(symbols, rows.slice(0, 2), result.asOf, "5m", defaultStrategy)
      .observationHash,
  );
  expect(
    summarizePool(
      [...symbols].reverse(),
      [...rows].reverse(),
      result.asOf,
      "5m",
      defaultStrategy,
    ).observationHash,
  ).toBe(result.observationHash);
  expect(result.warnings.join(" ")).toContain("分钟周期不是日涨跌");
  const large = rows.map((item, index) => ({
    ...item,
    amount: index === 0 ? 1e16 : 1,
  }));
  expect(
    summarizePool(symbols, large, result.asOf, "5m", defaultStrategy).amount,
  ).toBe(
    summarizePool(
      symbols,
      [...large].reverse(),
      result.asOf,
      "5m",
      defaultStrategy,
    ).amount,
  );
  expect(
    summarizePool(symbols, [], null, "day", defaultStrategy),
  ).toMatchObject({ observed: 0, meanChange: null, medianChange: null });
});
