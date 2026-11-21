import { expect, it } from "vitest";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "tstdx/financial-model";
import type { LocalFactorSource } from "trading-strategy-core/factors";
import {
  firstVintageValuations,
  lowZoneFinancialFacts,
} from "~/server/research/validation-financials";
import { lifecycleFinancialValuations } from "~/server/research/lifecycle/low-zone";

it("batch projections preserve PIT, units, missing days and duplicate same-day records", () => {
  const reports: FinancialReportSnapshot[] = [
    ["2026-09-30", 16000],
    ["2025-12-31", 20000],
    ["2025-09-30", 12000],
  ].map(([reportDate, profit]) => {
    const raw = new Array<number>(658).fill(0);
    raw[95] = Number(profit);
    raw[270] = 200000;
    return {
      symbol: "sh600519",
      reportDate: String(reportDate),
      announcementDate: "2026-10-30",
      availableFrom: "2026-11-02",
      calendar: { hash: "QA", source: "QA" },
      financialCompany: false,
      sourceFilename: "QA",
      sourceSha256: "QA",
      contentSha256: "QA",
      recordOffset: 0,
      mappingVersion: financialMappingVersion,
      fields: projectFinancialFields(raw, false),
      warnings: [],
    };
  });
  const series: LocalFactorSource = {
    namespace: "GP",
    filename: "QA",
    sourceSha256: "QA",
    records: [
      { date: 20261101, group: 16, values: [100, 0], offset: 0 },
      { date: 20261102, group: 16, values: [100, 0], offset: 13 },
      { date: 20261104, group: 16, values: [100, 0], offset: 26 },
      { date: 20261104, group: 16, values: [999, 0], offset: 39 },
      { date: null, group: 16, values: [999, 0], offset: 52 },
    ],
  };
  const dates = ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"];
  const before = structuredClone({ reports, series });
  const full = lowZoneFinancialFacts(
    reports,
    series,
    dates,
    "current-revision-diagnostic",
  );
  const slim = lowZoneFinancialFacts(
    reports.map((r) => ({
      ...r,
      fields: r.fields.filter((f) => ["FN96", "FN271"].includes(f.code)),
    })),
    series,
    dates,
    "current-revision-diagnostic",
  );
  expect(slim).toEqual(full);
  // GP16's 100 is 1,000,000 yuan. Financial raw fields here are already yuan:
  // TTM profit = 16,000 + 20,000 - 12,000; equity = 200,000.
  expect(full.map((f) => [f.pe, f.pb])).toEqual([
    [null, null],
    [1_000_000 / 24_000, 1_000_000 / 200_000],
    [null, null],
    [null, null],
  ]);
  expect(
    full.every((f) => f.temperature === null && f.confidence === "approximate"),
  ).toBe(true);
  expect({ reports, series }).toEqual(before);
  const strict = lowZoneFinancialFacts(reports, series, dates);
  expect(strict).toEqual(full.map((row) => ({ ...row, pe: null, pb: null })));
  expect(strict[1]).toMatchObject({
    vintage: "current-revision",
    knownAt: null,
  });
  expect(firstVintageValuations(full)).toEqual(strict);

  const current = { ...full[1]!, knownAt: dates[1]!, temperature: 20 };
  const first = { ...current, vintage: "first-observed" as const };
  const late = { ...first, knownAt: dates[2]! };
  const [unsupported, supported, unpublished] = firstVintageValuations([
    current,
    first,
    late,
  ]);
  expect(unsupported).toMatchObject({ pe: null, pb: null, temperature: 20 });
  expect(supported).toEqual(first);
  expect(unpublished).toMatchObject({ pe: null, pb: null });

  const symbol = "sh600519";
  const lifecycle = lifecycleFinancialValuations(
    {
      version: "csi800-financial-1",
      priceHash: "QA",
      reports: { [symbol]: reports },
      caps: { [symbol]: { [dates[1]!]: 1_000_000 } },
      seriesSources: { [symbol]: { hash: "QA" } },
    },
    [symbol],
    dates,
    "QA",
    "first-vintage",
  );
  expect(lifecycle).toMatchObject([
    {
      date: dates[1],
      marketCap: 1_000_000,
      pe: null,
      pb: null,
      vintage: "current-revision",
      knownAt: null,
    },
  ]);
});
