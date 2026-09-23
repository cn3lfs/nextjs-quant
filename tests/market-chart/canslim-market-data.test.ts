import { expect, it } from "vitest";
import { parseCanslimMarket } from "../../src/server/strategies/canslim/canslim-market-data";
const day = (date = "2025-01-02", symbol = "sh000300") => ({
  symbol,
  date,
  open: 100,
  last: 101,
  high: 102,
  low: 99,
  volume: 100,
  amount: 1000,
});
const cutoff = Date.parse("2025-01-03T15:04:00+08:00");
it("selects exact index and excludes unfinished bars with explicit index units", () => {
  const r = parseCanslimMarket(
    [day("2025-01-03"), day(), day("2025-01-02", "sh000001")],
    cutoff,
    cutoff,
  );
  expect(r.snapshot.bars).toHaveLength(1);
  expect(r.envelope.unit.price).toBe("点");
  expect(r.snapshot.bars[0]!.close).toBe(101);
  expect(r.diagnostic.checks.every((c) => c.status === "missing")).toBe(true);
});
it("rejects missing identity, wrong index, duplicates, malformed OHLC and dates", () => {
  for (const raw of [
    [{ ...day(), symbol: undefined }],
    [day("2025-01-02", "sh600519")],
    [day(), day()],
    [{ ...day(), high: 100 }],
    [day("2025-02-30")],
    [day("2025-01-02", "sh000001")],
  ]) {
    expect(() => parseCanslimMarket(raw, cutoff, cutoff)).toThrow();
  }
});
