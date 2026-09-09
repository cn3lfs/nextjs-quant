import { expect, it } from "vitest";
import { sectorPriceMetrics } from "~/server/sector-price-metrics";
const symbol = "pt01801080";
const rows = [symbol, "sh000001"].flatMap((symbol) =>
  Array.from({ length: 32 }, (_, i) => ({
    symbol,
    date: new Date(Date.UTC(2026, 7, i + 1)).toISOString().slice(0, 10),
    last: 100 + i,
    volume: i >= 27 ? 200 : 100,
  })),
);
it("uses completed bars and matching benchmark dates, with explicit interval and volume formulas", () => {
  const report = sectorPriceMetrics(
    rows,
    [symbol],
    Date.parse("2026-09-01T16:00:00+08:00"),
  );
  expect(report.results[0]).toMatchObject({
    bars: 31,
    return30: (131 / 101 - 1) * 100,
    return5: (131 / 126 - 1) * 100,
    excess5: 0,
    closeDrawdown: 0,
    volumeRatio: 2,
  });
  const beforeClose = sectorPriceMetrics(
    rows,
    [symbol],
    Date.parse("2026-09-01T14:00:00+08:00"),
  );
  expect(beforeClose.results[0]!.asOf).toBe("2026-08-31");
});
it("does not compare misaligned periods or manufacture returns from short windows", () => {
  const missingBenchmark = rows.filter(
    (r) => r.symbol !== "sh000001" || r.date !== "2026-08-31",
  );
  expect(
    sectorPriceMetrics(missingBenchmark, [symbol], Date.parse("2026-09-02"))
      .results[0]!.excess5,
  ).toBeNull();
  const short = sectorPriceMetrics(
    rows.slice(0, 3),
    [symbol],
    Date.parse("2026-09-02"),
  ).results[0]!;
  expect(short.return30).toBeNull();
  expect(short.return5).toBeNull();
  expect(short.volumeRatio).toBeNull();
});
it("rejects duplicate dates, unexpected symbols and invalid dates or prices", () => {
  const cutoff = Date.parse("2026-09-02");
  expect(() =>
    sectorPriceMetrics([...rows, rows[0]], [symbol], cutoff),
  ).toThrow("重复");
  expect(() =>
    sectorPriceMetrics([{ ...rows[0], symbol: "other" }], [symbol], cutoff),
  ).toThrow("未请求");
  expect(() =>
    sectorPriceMetrics([{ ...rows[0], date: "2026-02-30" }], [symbol], cutoff),
  ).toThrow();
  expect(() =>
    sectorPriceMetrics([{ ...rows[0], last: 0 }], [symbol], cutoff),
  ).toThrow();
});
