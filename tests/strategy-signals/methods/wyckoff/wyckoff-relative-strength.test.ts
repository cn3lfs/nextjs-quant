import { expect, it } from "vitest";
import type { Snapshot } from "~/lib/domain";
import { wyckoffRelativeStrength } from "~/server/strategies/wyckoff/wyckoff-relative-strength";
import { wyckoffRelativeStrengthFacts } from "trading-strategies/research/wyckoff/wyckoff-relative-strength-facts";
const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
const series = (symbol: string, prices: number[]): Snapshot => ({
  id: symbol,
  symbol,
  source: "fixture",
  hash: "untrusted",
  period: "day",
  adjustment: "none",
  createdAt: 1,
  bars: prices.map((close, i) => ({
    date: dates[i]!,
    close,
    open: close,
    high: close,
    low: close,
    volume: 1,
    amount: close,
  })),
});
it("normalizes ratios to 100 and preserves prices without substituting excess returns", () => {
  const stock = series("sh600519", [100, 110, 121]),
    benchmark = series("sh000300", [100, 105, 110]);
  const before = structuredClone(stock);
  const result = wyckoffRelativeStrength(
    stock,
    benchmark,
    dates[0]!,
    dates[2]!,
  );
  expect(result.status).toBe("computed");
  expect(result.rows[0]!.rs).toBe(100);
  expect(result.rows[1]!.rs).toBeCloseTo(104.76190476);
  expect(result.rows[2]!.rs).toBeCloseTo(110);
  expect(result.changePercent).toBeCloseTo(10);
  expect(result.changePercent).not.toBeCloseTo(21 - 10);
  // Characterized from the pre-extraction server implementation at 874456eb9f59.
  expect(result.hash).toBe(
    "de9de9743b635474bba6e5f555c34367fd67f4c89f706f913a5470648beaec45",
  );
  const { hash: _hash, ...facts } = result;
  expect(
    wyckoffRelativeStrengthFacts(stock, benchmark, dates[0]!, dates[2]!),
  ).toEqual(facts);
  expect(stock).toEqual(before);
});
it("refuses to rebase or interpolate missing endpoints and interior dates", () => {
  const stock = series("sh600519", [100, 110, 121]),
    benchmark = series("sh000300", [100, 105, 110]);
  benchmark.bars.splice(1, 1);
  const result = wyckoffRelativeStrength(
    stock,
    benchmark,
    dates[0]!,
    dates[2]!,
  );
  expect(result).toMatchObject({
    status: "missing",
    rows: [],
    changePercent: null,
    missingBenchmarkDates: [dates[1]],
  });
  stock.bars.shift();
  expect(
    wyckoffRelativeStrength(stock, benchmark, dates[0]!, dates[2]!)
      .missingStockDates,
  ).toContain(dates[0]);
});
it("rejects invalid series and hashes actual input revisions", () => {
  const stock = series("sh600519", [100, 110, 121]),
    benchmark = series("sh000300", [100, 105, 110]);
  const before = wyckoffRelativeStrength(
    stock,
    benchmark,
    dates[0]!,
    dates[2]!,
  ).hash;
  benchmark.bars[1]!.close++;
  expect(
    wyckoffRelativeStrength(stock, benchmark, dates[0]!, dates[2]!).hash,
  ).not.toBe(before);
  benchmark.bars[1]!.close = 0;
  expect(() =>
    wyckoffRelativeStrength(stock, benchmark, dates[0]!, dates[2]!),
  ).toThrow();
  expect(() =>
    wyckoffRelativeStrength(stock, stock, dates[0]!, dates[2]!),
  ).toThrow();
});
