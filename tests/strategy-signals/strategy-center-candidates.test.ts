import { expect, it, vi } from "vitest";
import type { Snapshot } from "~/lib/domain";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import type { LocalFactorSource } from "trading-strategy-core/factors";
vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: vi.fn(),
  readLocalFinancialSeries: vi.fn(),
}));
import {
  captureStrategyCandidates,
  strategyCenterCandidatesSchema,
} from "~/server/strategies/strategy-center-candidates";

function fixture() {
  const bars = Array.from({ length: 300 }, (_, i) => ({
    date: new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100 + i,
    high: 102 + i,
    low: 99 + i,
    close: 101 + i,
    volume: 100000,
    amount: 10000000,
  }));
  const source: Snapshot = {
    id: "fixture",
    symbol: "sh600519",
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    createdAt: 1,
    hash: "stock-hash",
    bars,
  };
  const benchmark = {
    ...structuredClone(source),
    symbol: "sh000300",
    hash: "benchmark-hash",
  };
  const series: LocalFactorSource = {
    namespace: "GP",
    filename: "gpsh600519.dat",
    sourceSha256: "series-hash",
    records: [
      {
        group: 16,
        date: Number(bars[270]!.date.replaceAll("-", "")),
        values: [100, 0],
        offset: 0,
      },
    ],
  };
  const readers = {
    readSnapshot: vi.fn(async (_root: string, symbol: string) =>
      symbol === "sh000300" ? benchmark : source,
    ),
    readLocalFinancialHistory: vi.fn(async () => ({
      reports: [] as FinancialReportSnapshot[],
    })),
    readLocalFinancialSeries: vi.fn(async () => series),
  };
  const input = {
    strategyId: "rank-momentum",
    symbols: [source.symbol],
    asOf: bars[270]!.date,
  };
  return { source, benchmark, series, readers, input };
}
function report(
  reportDate: string,
  announcementDate: string,
  profit: number,
): FinancialReportSnapshot {
  const raw = new Array<number>(658).fill(0);
  raw[95] = profit;
  raw[270] = 200000;
  return {
    symbol: "sh600519",
    reportDate,
    announcementDate,
    financialCompany: false,
    sourceFilename: "fixture.dat",
    sourceSha256: reportDate,
    contentSha256: reportDate,
    recordOffset: 1,
    mappingVersion: financialMappingVersion,
    fields: projectFinancialFields(raw, false),
    warnings: [],
  };
}
it("validates explicit dates, known ranking strategy, unique symbols and max6000", () => {
  const { input } = fixture();
  for (const change of [
    { asOf: "2024-02-30" },
    { strategyId: "ma" },
    { symbols: ["bad"] },
    { symbols: ["sh600519", "sh600519"] },
    {
      symbols: Array.from(
        { length: 6001 },
        (_, i) => `sh60${String(i).padStart(4, "0")}`,
      ),
    },
  ])
    expect(
      strategyCenterCandidatesSchema.safeParse({ ...input, ...change }).success,
    ).toBe(false);
});
it("uses exactly 250/20 past closes, records hashes and ignores future prices", async () => {
  const f = fixture();
  const run = await captureStrategyCandidates(f.input, "fixture", f.readers);
  expect(run.candidates[0]!.values.momentum).toBeCloseTo(
    f.source.bars[250]!.close / f.source.bars[20]!.close - 1,
    10,
  );
  expect(run.exclusions).toEqual([]);
  expect(run.evidence[0]!.barsHash).toBe("stock-hash");
  for (const b of f.source.bars.slice(271)) b.close = 999999;
  expect(
    (await captureStrategyCandidates(f.input, "fixture", f.readers)).candidates,
  ).toEqual(run.candidates);
  expect(f.readers.readLocalFinancialHistory).not.toHaveBeenCalled();
});
it("shortReturn is actual return, so ascending ranks buy past losers", async () => {
  const f = fixture();
  const run = await captureStrategyCandidates(
    { ...f.input, strategyId: "rank-reversal" },
    "fixture",
    f.readers,
  );
  expect(run.candidates[0]!.values.shortReturn).toBeCloseTo(
    f.source.bars[270]!.close / f.source.bars[265]!.close - 1,
    10,
  );
});
it("uses shared sample volatility and same-calendar CSI300 beta", async () => {
  const f = fixture();
  const beta = await captureStrategyCandidates(
    { ...f.input, strategyId: "rank-low-beta" },
    "fixture",
    f.readers,
  );
  expect(beta.candidates[0]!.values.beta).toBeCloseTo(1, 12);
  const vol = await captureStrategyCandidates(
    { ...f.input, strategyId: "rank-low-volatility" },
    "fixture",
    f.readers,
  );
  expect(vol.candidates[0]!.values.volatility).toBeGreaterThan(0);
});
it("isolates missing sessions and repaired sources without synthesizing candidates", async () => {
  const f = fixture();
  f.source.bars.splice(260, 1);
  const missing = await captureStrategyCandidates(
    f.input,
    "fixture",
    f.readers,
  );
  expect(missing.candidates).toEqual([]);
  expect(missing.exclusions[0]!.reason).toContain("日历不一致");
  f.source.sourceNote = "repaired";
  expect(
    (await captureStrategyCandidates(f.input, "fixture", f.readers))
      .exclusions[0]!.reason,
  ).toContain("修复");
});
it("leaves insufficient warmup unknown instead of filling zero", async () => {
  const f = fixture();
  f.source.bars = f.source.bars.slice(220);
  const run = await captureStrategyCandidates(f.input, "fixture", f.readers);
  expect(run.candidates[0]!.values.momentum).toBeNull();
  expect(run.exclusions[0]!.reason).toContain("momentum");
});
it("reads same-day GP marketcap without loading prices and never forward-fills", async () => {
  const f = fixture();
  const run = await captureStrategyCandidates(
    { ...f.input, strategyId: "rank-small-cap" },
    "fixture",
    f.readers,
  );
  expect(run.candidates[0]!.values.marketCap).toBeGreaterThan(0);
  expect(f.readers.readSnapshot).not.toHaveBeenCalled();
  f.series.records[0]!.date = 20200101;
  expect(
    (
      await captureStrategyCandidates(
        { ...f.input, strategyId: "rank-small-cap" },
        "fixture",
        f.readers,
      )
    ).candidates[0]!.values.marketCap,
  ).toBeNull();
});
it("requests strict financial visibility and independently excludes later announcements", async () => {
  const f = fixture();
  f.input.asOf = "2024-05-10";
  f.readers.readLocalFinancialHistory.mockResolvedValue({
    reports: [
      report("2024-03-31", "2024-06-01", 999999),
      report("2023-12-31", "2024-04-01", 20000),
    ],
  });
  const run = await captureStrategyCandidates(
    { ...f.input, strategyId: "rank-quality" },
    "fixture",
    f.readers,
  );
  expect(f.readers.readLocalFinancialHistory).toHaveBeenCalledWith(
    "fixture",
    "sh600519",
    { asOf: f.input.asOf, strict: true, limit: 160 },
  );
  expect(run.candidates[0]!.values.roe).toBeCloseTo(0.1);
  expect(run.evidence[0]!.reportHashes).toEqual(["2023-12-31"]);
});
it("equal allocation needs no source reads, and missing reports remain explicit", async () => {
  const f = fixture();
  const equal = await captureStrategyCandidates(
    { ...f.input, strategyId: "allocation-equal" },
    "fixture",
    f.readers,
  );
  expect(equal.candidates).toEqual([
    { symbol: "sh600519", availableAt: f.input.asOf, values: {} },
  ]);
  expect(f.readers.readSnapshot).not.toHaveBeenCalled();
  const quality = await captureStrategyCandidates(
    { ...f.input, strategyId: "rank-quality" },
    "fixture",
    f.readers,
  );
  expect(quality.candidates[0]!.values.roe).toBeNull();
  expect(quality.exclusions[0]!.reason).toContain("roe");
});
