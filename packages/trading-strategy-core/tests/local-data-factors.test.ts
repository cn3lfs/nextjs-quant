import { expect, it } from "vitest";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "../src/financial/index.js";
import {
  calculateLocalDataFactors,
  localDataFactorCatalog,
  localDataFactorConditionSchema,
  type LocalFactorSource,
} from "../src/factors/index.js";
import type { Bar } from "../src/bars.js";
const source: LocalFactorSource = {
  namespace: "GP",
  filename: "gpsh600519.dat",
  sourceSha256: "s".repeat(64),
  records: [
    { group: 16, date: 20261106, values: [100, 0], offset: 0 },
    { group: 3, date: 20261106, values: [5, 200], offset: 13 },
    { group: 7, date: 20261106, values: [-2, 0], offset: 26 },
    { group: 21, date: 20261106, values: [3.5, 0], offset: 39 },
  ],
};
function report(
  reportDate: string,
  income: number,
  profit: number,
  cash: number,
): FinancialReportSnapshot {
  const raw = new Array<number>(658).fill(0);
  for (const [id, value] of [
    [74, income],
    [96, profit],
    [107, cash],
    [271, 200000],
  ])
    raw[id! - 1] = value!;
  return {
    symbol: "sh600519",
    reportDate,
    announcementDate: "2026-10-30",
    financialCompany: false,
    sourceFilename: `gpcw${reportDate}.dat`,
    sourceSha256: reportDate,
    contentSha256: reportDate,
    recordOffset: 1,
    mappingVersion: financialMappingVersion,
    fields: projectFinancialFields(raw, false),
    warnings: [],
  };
}
const reports = [
  report("2026-09-30", 90000, 16000, 20000),
  report("2025-12-31", 100000, 20000, 25000),
  report("2025-09-30", 60000, 12000, 15000),
];
const calculate = (ids: string[], stock: LocalFactorSource = source) =>
  calculateLocalDataFactors({ ids, asOf: "2026-11-06", stock, reports });
it("connects every documented numeric namespace side and keeps units distinct", () => {
  expect(new Set(localDataFactorCatalog.map((f) => f.id)).size).toBe(
    localDataFactorCatalog.length,
  );
  expect(localDataFactorCatalog.some((f) => f.id === "GP33-0")).toBe(false);
  expect(localDataFactorCatalog.some((f) => f.id === "GP51-0")).toBe(false);
  expect(localDataFactorCatalog.some((f) => f.id === "GP40-1")).toBe(false);
  expect(calculate(["GP16-0", "GP21-0", "GP7-0"]).map((f) => f.value)).toEqual([
    1000000, 3.5, -20000,
  ]);
  expect(calculate(["GP16-0"])[0]!.inputs[0]).toMatchObject({
    raw: 100,
    value: 1000000,
    unit: "元",
    offset: 0,
    sourceSha256: source.sourceSha256,
  });
  const market = {
    ...source,
    namespace: "SC" as const,
    records: [
      {
        group: 3,
        date: 20261106,
        values: [8, 12] as [number, number],
        offset: 0,
      },
    ],
  };
  expect(
    calculateLocalDataFactors({
      ids: ["SC3-0"],
      asOf: "2026-11-06",
      market,
      reports: [],
    })[0]!.value,
  ).toBe(8);
  expect(
    calculateLocalDataFactors({
      ids: ["BK10-0"],
      asOf: "2026-11-06",
      block: {
        ...market,
        namespace: "BK",
        records: [{ ...market.records[0]!, group: 10 }],
      },
      reports: [],
    })[0]!.value,
  ).toBe(8e8);
  expect(
    localDataFactorConditionSchema.safeParse({
      id: "GO1",
      operator: "gt",
      threshold: 0,
    }).success,
  ).toBe(false);
});
it("combines same-day market cap and actual TTM components, preserving loss yields but rejecting negative PE", () => {
  const actual = calculate([
    "pe-ttm",
    "pb",
    "ps-ttm",
    "pcf-ttm",
    "earnings-yield",
    "book-to-price",
    "sales-to-price",
    "cashflow-yield",
    "log-market-cap",
    "financing-to-cap",
    "northbound-net-to-cap",
  ]);
  expect(actual.map((f) => f.value)).toEqual([
    1000000 / 24000,
    5,
    1000000 / 130000,
    1000000 / 30000,
    2.4,
    20,
    13,
    3,
    Math.log(1000000),
    5,
    -2,
  ]);
  expect(
    actual[0]!.inputs
      .filter((f) => f.source === "financial-report")
      .map((f) => f.date),
  ).toEqual(["2025-12-31", "2026-09-30", "2025-09-30"]);
  expect(
    calculateLocalDataFactors({
      ids: ["pe-ttm"],
      asOf: "2026-11-06",
      stock: source,
      reports: reports.slice(0, 1),
    })[0]!.value,
  ).toBeNull();
  const losses = [report("2025-12-31", 100, -1000, -100)];
  expect(
    calculateLocalDataFactors({
      ids: ["pe-ttm", "earnings-yield"],
      asOf: "2026-11-06",
      stock: source,
      reports: losses,
    }).map((f) => f.value),
  ).toEqual([null, -0.1]);
});
it("never fills undated, stale, duplicate or uncertified zero observations", () => {
  for (const records of [
    [],
    [{ ...source.records[0]!, date: null }],
    [{ ...source.records[0]!, date: 20261105 }],
    [source.records[0]!, source.records[0]!],
    [{ ...source.records[0]!, values: [0, 0] as [number, number] }],
  ]) {
    expect(calculate(["GP16-0"], { ...source, records })[0]!.value).toBeNull();
  }
  expect(
    calculate(["GP16-0"], { ...source, namespace: "BK" })[0]!.reason,
  ).toContain("命名空间");
  expect(
    calculate(["GP16-0"], {
      ...source,
      records: [
        source.records[0]!,
        { ...source.records[0]!, values: [300, 0], offset: 13 },
      ],
    })[0]!.inputs.map((e) => e.raw),
  ).toEqual([100, 300]);
  const unchanged = structuredClone(source);
  expect(
    calculate(["GP16-0"], {
      ...source,
      records: [...source.records, { ...source.records[0]!, date: 20261109 }],
    }),
  ).toEqual(calculate(["GP16-0"]));
  expect(source).toEqual(unchanged);
});
it("fits market returns with an intercept and rejects missing or mismatched trading dates", () => {
  let stock = 100,
    market = 100;
  const bars: Bar[] = [],
    benchmark: Bar[] = [];
  for (let i = 0; i < 61; i++) {
    if (i) {
      const r = i % 2 ? 0.01 : -0.005;
      market *= 1 + r;
      stock *= 1 + 0.001 + 2 * r;
    }
    const date = new Date(Date.UTC(2026, 8, 6 + i)).toISOString().slice(0, 10);
    const bar = {
      date,
      close: stock,
      high: stock,
      low: stock,
      open: stock,
      volume: 1,
      amount: 100,
    };
    bars.push(bar);
    benchmark.push({ ...bar, close: market });
  }
  const input = {
    ids: ["market-beta-60", "market-correlation-60", "residual-volatility-60"],
    asOf: bars.at(-1)!.date,
    reports: [],
    bars,
    benchmark,
    barsHash: "stock",
    benchmarkHash: "benchmark",
  };
  const actual = calculateLocalDataFactors(input);
  expect(actual[0]!.value).toBeCloseTo(2, 10);
  expect(actual[1]!.value).toBeCloseTo(1, 10);
  expect(actual[2]!.value).toBeCloseTo(0, 10);
  expect(actual[0]!.inputs).toHaveLength(122);
  expect(
    calculateLocalDataFactors({
      ...input,
      benchmark: benchmark.slice(1),
    }).every((f) => f.value === null),
  ).toBe(true);
  expect(
    calculateLocalDataFactors({
      ...input,
      benchmark: benchmark.map((b, i) =>
        i === 4 ? { ...b, date: "wrong-date" } : b,
      ),
    }).every((f) => f.value === null),
  ).toBe(true);
  expect(
    calculateLocalDataFactors({
      ...input,
      benchmark: benchmark.map((b) => ({ ...b, close: 100 })),
    }).every((f) => f.value === null),
  ).toBe(true);
});
