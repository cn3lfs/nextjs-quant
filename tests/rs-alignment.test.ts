import { expect, it } from "vitest";
import { rsAlignmentEvidence } from "../src/server/rs-alignment";
import { fullRsSnapshot, rankInSnapshot } from "../src/server/hithink-rs";
import { evidenceEnvelope } from "../src/server/evidence";
import type { Snapshot, Evidence } from "../src/lib/domain";
const source: Snapshot = {
  id: "stock-fixture",
  symbol: "sh600519",
  period: "day",
  source: "fixture",
  adjustment: "none",
  createdAt: 1,
  hash: "stock-hash",
  bars: Array.from({ length: 61 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: i === 60 ? 110 : 100,
    volume: 100,
    amount: 10000,
  })),
};
const range = "20260101-20260302",
  key = `涨跌幅[${range}]`;
const archived = fullRsSnapshot({
  status_code: 0,
  code_count: 2,
  columns: [
    { key, timestamp: range, unit: "%", type: "DOUBLE", sort_info: "desc" },
  ],
  datas: [
    { 股票代码: "600519.SH", [key]: 10 },
    { 股票代码: "000001.SZ", [key]: 0 },
  ],
});
const payload = rankInSnapshot(source.symbol, archived);
const evidence: Evidence = {
  id: "rs-fixture",
  source: "fixture",
  asOf: range,
  text: JSON.stringify(payload),
  envelope: evidenceEnvelope(payload, {
    source: "hithink-astock-selector/rs",
    symbol: source.symbol,
    type: "quote-financial",
    asOf: null,
    publishedAt: null,
    fetchedAt: 1,
    currency: null,
    unit: {},
    adjustment: "unknown",
    reportPeriod: null,
    quality: "partial",
    warnings: [],
  }),
};
function check(stock = source, rs = evidence) {
  return JSON.parse(rsAlignmentEvidence(stock, rs).text);
}
it("links both immutable snapshots and compares exact endpoints and 60 intervals without claiming full RS eligibility", () => {
  const result = check();
  expect(result).toMatchObject({
    comparable: true,
    endpointMatch: true,
    latestMatch: true,
    sixtyIntervals: true,
    returnMatches: true,
    rsEvidenceId: evidence.id,
    stockSnapshotHash: source.hash,
    rsSnapshotHash: archived.hash,
  });
  expect(result.warnings.join(" ")).toContain("不直接解除");
  expect(check({ ...source, bars: source.bars.slice(0, -1) })).toMatchObject({
    comparable: false,
    endpointMatch: false,
    latestMatch: false,
  });
  expect(
    check({ ...source, bars: source.bars.filter((_, i) => i !== 20) }),
  ).toMatchObject({
    comparable: false,
    sixtyIntervals: false,
    endpointMatch: true,
  });
  expect(check({ ...source, period: "5m" }).comparable).toBe(false);
  expect(
    check(source, {
      ...evidence,
      text: JSON.stringify({ ...payload, change: 11 }),
    }),
  ).toMatchObject({ comparable: false, returnMatches: false });
});
it("rejects wrong security, source, hash and invalid ranges instead of creating a successful comparison", () => {
  for (const patch of [
    { symbol: "sz000001" },
    { snapshotHash: "b".repeat(64) },
    { range: "20260230-20260302" },
  ])
    expect(() =>
      check(source, {
        ...evidence,
        text: JSON.stringify({ ...payload, ...patch }),
      }),
    ).toThrow();
  expect(() => check(source, { ...evidence, envelope: undefined })).toThrow();
});
