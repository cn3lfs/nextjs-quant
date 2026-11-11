import { expect, it, vi } from "vitest";
import {
  classicFinancialFeatures,
  evaluateStrategy,
  riskParityWeights,
} from "trading-strategies";
import type { FinancialReportSnapshot } from "trading-strategy-core/financial";
import { classifySecurityCode } from "trading-strategy-core/security";
import { classifyCode } from "~/lib/research/evidence/delivery-import";
vi.mock("~/server/data-sources/tdx/tdx", () => ({ readSnapshot: vi.fn() }));
vi.mock("~/server/data-sources/tdx/local-financial-files", () => ({
  readLocalFinancialHistory: vi.fn(),
  readLocalFinancialSeries: vi.fn(),
}));
import { captureStrategyCandidates } from "~/server/strategies/strategy-center-candidates";
import { canslimEntry } from "trading-strategies/research/canslim/canslim-entry";
import { canslimTechnical } from "trading-strategies/research/canslim/canslim-technical";
import { asOfInputDefinitions } from "~/lib/research/evidence/as-of-inputs";
import { asOfObservationSchema } from "~/lib/research/evidence/as-of";
import { asOfDomains } from "trading-strategies/research/contracts/as-of-domain";
import {
  valueQualitySchema,
  valueGuoSchema,
  valueRiskSchema,
  valueMarketSchema,
  valuePolicySchema,
  valueGovernanceSchema,
} from "trading-strategies/research/contracts/value-inputs";

it("growth rules use only the explicit clock and reject unfinished or historically future bars", () => {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    open: 100 + index,
    close: 100.5 + index,
    high: 101 + index,
    low: 99 + index,
    volume: 1000,
    amount: 100000,
  }));
  const date = bars.at(-1)!.date;
  const snapshot = {
    id: "fixture",
    hash: "fixture",
    symbol: "sh600519",
    period: "day" as const,
    adjustment: "none" as const,
    historicalAsOf: date,
    bars,
  };
  const finished = Date.parse(`${date}T15:05:00+08:00`);
  const incomplete = Date.parse(`${date}T15:04:00+08:00`);
  expect(canslimEntry(snapshot, 140, 0, true, incomplete).asOf).toBeNull();
  expect(canslimEntry(snapshot, 140, 0, true, finished).asOf).toBe(date);
  const original = structuredClone(snapshot);
  const wallClock = vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("Rule attempted to read ambient wall clock");
  });
  try {
    const first = canslimTechnical(snapshot, finished);
    expect(canslimTechnical(snapshot, finished)).toEqual(first);
    const future = {
      ...snapshot,
      bars: [...bars, { ...bars.at(-1)!, date: "2025-02-10" }],
    };
    expect(
      canslimEntry(
        future,
        140,
        0,
        true,
        Date.parse("2025-02-11T16:00:00+08:00"),
      ).asOf,
    ).toBeNull();
  } finally {
    wallClock.mockRestore();
  }
  expect(snapshot).toEqual(original);
});

it("shared instrument facts classify strict codes while delivery parsing owns raw-cell normalization", () => {
  expect(classifySecurityCode("510300")).toMatchObject({
    market: "sh",
    instrument: "fund",
  });
  expect(classifySecurityCode("159919")).toMatchObject({
    market: "sz",
    instrument: "fund",
  });
  expect(classifySecurityCode("600519")).toMatchObject({
    market: "sh",
    instrument: "stock",
  });
  expect(classifySecurityCode("204001")).toMatchObject({
    market: "sh",
    instrument: "reverseRepo",
  });
  expect(classifySecurityCode('="510300"')).toMatchObject({
    market: null,
    instrument: "other",
  });
  expect(classifyCode('="510300"')).toEqual(classifySecurityCode("510300"));
});

it("app evidence adapters compose the package's actual value contracts and domain vocabulary", () => {
  expect(asOfObservationSchema.shape.domain.options).toBe(asOfDomains);
  expect(asOfInputDefinitions.finance.annualValueQuality!.schema).toBe(
    valueQualitySchema,
  );
  expect(asOfInputDefinitions.finance.annualGuo!.schema).toBe(valueGuoSchema);
  for (const [field, schema] of [
    ["valueRisk", valueRiskSchema],
    ["valueMarket", valueMarketSchema],
    ["valuePolicy", valuePolicySchema],
    ["valueGovernance", valueGovernanceSchema],
  ] as const)
    expect(asOfInputDefinitions.capital[field]!.schema).toBe(schema);
  const quality = {
    revenue: 100,
    netIncome: 10,
    assets: 100,
    equity: 50,
    operatingCashFlow: 20,
    capex: 5,
    longDebt: 10,
    liabilities: 50,
    currentAssets: 20,
    currentLiabilities: 10,
    grossProfit: 30,
    issuedShares: 10,
    shares: 100,
    interestExpense: 1,
    ebit: 15,
    investedCapital: 60,
    taxRate: 0.25,
    dividendPerShare: 1,
  };
  expect(valueQualitySchema.safeParse(quality).success).toBe(true);
  expect(
    valueQualitySchema.safeParse({
      ...quality,
      netIncome: Number.POSITIVE_INFINITY,
    }).success,
  ).toBe(false);
  expect(
    valueQualitySchema.safeParse({ ...quality, inventedField: 1 }).success,
  ).toBe(false);
  expect(valueQualitySchema.safeParse({ ...quality, assets: 0 }).success).toBe(
    false,
  );
});

function report(
  date: string,
  visible: string,
  amounts: Record<number, number>,
): FinancialReportSnapshot {
  return {
    symbol: "sh600519",
    financialCompany: false,
    reportDate: date,
    announcementDate: visible,
    availableFrom: visible,
    sourceFilename: "fixture",
    sourceSha256: date,
    contentSha256: date,
    recordOffset: 0,
    mappingVersion: "fixture",
    warnings: [],
    fields: Object.entries(amounts).map(([code, value]) => ({
      code: `FN${code}`,
      label: code,
      section: "fixture",
      slot: +code - 1,
      raw: value,
      value,
      unit: "元",
      rawUnit: "元",
      scale: 1,
      timing: "cumulative",
      status: "value",
      reason: null,
    })),
  };
}

it("financial classic inputs preserve annual GP assets, TTM cash quality and same-quarter investment timing", () => {
  const reports = [
    report("2024-03-31", "2024-05-01", {
      40: 1500,
      74: 350,
      75: 200,
      95: 30,
      96: 30,
      107: 25,
    }),
    report("2023-12-31", "2024-04-01", {
      40: 1000,
      74: 1000,
      75: 600,
      95: 100,
      96: 100,
      107: 80,
    }),
    report("2023-03-31", "2023-05-01", {
      40: 1100,
      74: 250,
      75: 100,
      95: 20,
      96: 20,
      107: 15,
    }),
    report("2024-06-30", "2024-08-01", {
      40: 9000,
      74: 9000,
      75: 1,
      95: 9000,
      96: 9000,
      107: 9000,
    }),
  ];
  const values = classicFinancialFeatures(reports, "2024-05-10")!.values;
  expect(values["gross-profit-assets"]).toBeCloseTo(0.4);
  expect(values["cash-quality"]).toBeCloseTo((90 - 110) / 1500);
  expect(values["asset-growth"]).toBeCloseTo((1500 - 1100) / 1100);
  expect(classicFinancialFeatures(reports, "2024-05-10")).toEqual(
    classicFinancialFeatures(reports.slice(0, 3), "2024-05-10"),
  );
});

it("new investment intake rejects nonpositive current assets but preserves genuine asset contraction", async () => {
  for (const currentAssets of [0, -50, 880]) {
    const reports = [
      report("2024-03-31", "2024-05-01", { 40: currentAssets }),
      report("2023-03-31", "2023-05-01", { 40: 1100 }),
    ];
    const result = await captureStrategyCandidates(
      {
        strategyId: "portfolio-conservative-investment",
        symbols: ["sh600519"],
        asOf: "2024-05-10",
      },
      "fixture",
      {
        readSnapshot: vi.fn(async () => {
          throw new Error("Unexpected price read");
        }),
        readLocalFinancialHistory: vi.fn(async () => ({ reports })),
        readLocalFinancialSeries: vi.fn(async () => {
          throw new Error("Unexpected series read");
        }),
      },
    );
    if (currentAssets <= 0) {
      expect(result.candidates[0]?.values.assetGrowth ?? null).toBeNull();
      expect(result.exclusions).toHaveLength(1);
    } else {
      expect(result.candidates[0]!.values.assetGrowth).toBeCloseTo(-0.2);
      expect(result.exclusions).toEqual([]);
    }
  }
});

it.each([
  ["portfolio-gross-profitability", "grossProfitability", 0.1, 0.4, "b"],
  ["portfolio-cash-accruals", "cashAccrualQuality", -0.2, 0.1, "b"],
  ["portfolio-conservative-investment", "assetGrowth", 0.1, 0.5, "a"],
] as const)(
  "%s ranks the declared existing feature in its economic direction",
  (strategyId, factor, low, high, selected) => {
    const result = evaluateStrategy(
      { strategyId, parameters: { topK: 1 } },
      {
        asOf: "2024-05-10",
        candidates: [
          { symbol: "a", availableAt: "2024-05-10", values: { [factor]: low } },
          {
            symbol: "b",
            availableAt: "2024-05-10",
            values: { [factor]: high },
          },
          {
            symbol: "future",
            availableAt: "2024-05-11",
            values: { [factor]: 100 },
          },
          {
            symbol: "missing",
            availableAt: "2024-05-10",
            values: { [factor]: null },
          },
        ],
      },
    );
    expect(result).toEqual({
      kind: "weights",
      weights: [{ symbol: selected, weight: 1 }],
      excluded: ["future", "missing"],
    });
  },
);

it("profitability-value combines common-sample factor ranks rather than raw incompatible scales", () => {
  const result = evaluateStrategy(
    { strategyId: "portfolio-profitability-value", parameters: { topK: 1 } },
    {
      asOf: "2024-05-10",
      candidates: [
        {
          symbol: "a",
          availableAt: "2024-05-10",
          values: { grossProfitability: 0.5, bookToPrice: 0.1 },
        },
        {
          symbol: "b",
          availableAt: "2024-05-10",
          values: { grossProfitability: 0.4, bookToPrice: 0.5 },
        },
        {
          symbol: "c",
          availableAt: "2024-05-10",
          values: { grossProfitability: 0.2, bookToPrice: 0.4 },
        },
      ],
    },
  );
  expect(result).toEqual({
    kind: "weights",
    weights: [{ symbol: "b", weight: 1 }],
    excluded: [],
  });
});

it("risk parity equalizes independently recomputed correlated three-asset risk contributions", () => {
  const dates = Array.from({ length: 60 }, (_, index) =>
    new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
  );
  const a = dates.map(
    (_, index) => 0.01 * Math.sin(index * 0.4) + 0.005 * Math.cos(index * 0.12),
  );
  const series = [
    a,
    a.map((value, index) => 0.8 * value + 0.008 * Math.sin(index * 0.7)),
    a.map((value, index) => -0.3 * value + 0.02 * Math.cos(index * 0.31)),
  ];
  const inputs = ["A", "B", "C"].map((symbol, index) => ({
    symbol,
    returns: dates.map((date, row) => ({ date, value: series[index]![row]! })),
  }));
  const original = structuredClone(inputs);
  const output = riskParityWeights(
    [inputs[2]!, inputs[0]!, inputs[1]!],
    dates.at(-1)!,
  );
  const means = series.map(
    (values) => values.reduce((sum, value) => sum + value, 0) / 60,
  );
  const covariance = series.map((left, i) =>
    series.map(
      (right, j) =>
        left.reduce(
          (sum, value, row) =>
            sum + (value - means[i]!) * (right[row]! - means[j]!),
          0,
        ) / 59,
    ),
  );
  const ridge =
    ((covariance[0]![0]! + covariance[1]![1]! + covariance[2]![2]!) / 3) * 1e-6;
  covariance.forEach((row, index) => {
    row[index] = row[index]! + ridge;
  });
  const weights = inputs.map(
    (input) =>
      output.weights.find((row) => row.symbol === input.symbol)!.weight,
  );
  const contributions = weights.map(
    (weight, i) =>
      weight *
      covariance[i]!.reduce((sum, value, j) => sum + value * weights[j]!, 0),
  );
  const totalRisk = contributions.reduce((sum, value) => sum + value, 0);
  expect(totalRisk).toBeGreaterThan(0);
  expect(weights.every((weight) => weight > 0 && Number.isFinite(weight))).toBe(
    true,
  );
  expect(weights.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
  contributions.forEach((value) =>
    expect(value / totalRisk).toBeCloseTo(1 / 3, 6),
  );
  const inverseVolatility = covariance.map(
    (row, index) => 1 / Math.sqrt(row[index]!),
  );
  const inverseTotal = inverseVolatility.reduce((sum, value) => sum + value, 0);
  expect(
    weights.some(
      (weight, index) =>
        Math.abs(weight - inverseVolatility[index]! / inverseTotal) > 0.01,
    ),
  ).toBe(true);
  expect(inputs).toEqual(original);
});
