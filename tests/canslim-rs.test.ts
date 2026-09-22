import { expect, it } from "vitest";
import { canslimRs } from "../src/server/strategies/canslim/canslim-rs";
import { evidenceEnvelope } from "../src/server/infra/evidence";
import type { Snapshot, Evidence } from "../src/lib/domain";
const stock = {
  id: "s",
  hash: "h",
  symbol: "sh600519",
  period: "day",
  bars: Array.from({ length: 61 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
  })),
} as Snapshot;
function evidence(percentile: number): Evidence {
  const payload = {
    version: "price-rs-evidence-1",
    symbol: stock.symbol,
    stockSnapshotId: stock.id,
    stockSnapshotHash: stock.hash,
    snapshotId: "pool",
    range: "20250101-20250302",
    endpointPricesMatch: true,
    percentile,
    eligibleCount: 100,
    declaredCount: 100,
    excludedCount: 0,
  };
  const envelope = evidenceEnvelope(payload, {
    source: "hithink-astock-selector/price-rs",
    symbol: stock.symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt: 1,
    currency: "CNY",
    unit: { percentile: "%" },
    adjustment: "none",
    reportPeriod: null,
    quality: "partial",
    warnings: [],
  });
  return {
    id: "rs",
    source: envelope.source,
    asOf: payload.range,
    envelope,
    text: JSON.stringify(payload),
  };
}
it("shows pool tiers but does not mistake partial coverage for full-market L1", () => {
  for (const [p, points] of [
    [69.99, 0],
    [70, 2],
    [80, 5],
    [90, 7],
    [95, 9],
  ])
    expect(canslimRs(stock, evidence(p!))).toMatchObject({
      status: "missing",
      points: 0,
      provisionalPoints: points,
      poolPercentile: p,
    });
});
it("rejects modified or cross-snapshot evidence", () => {
  const e = evidence(95);
  e.text = e.text.replace('"percentile":95', '"percentile":99');
  expect(() => canslimRs(stock, e)).toThrow("校验");
  expect(() => canslimRs({ ...stock, hash: "other" }, evidence(95))).toThrow(
    "窗口",
  );
});
