import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  financialMappingVersion,
  projectFinancialFields,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { classicFinancialFeatures } from "../src/csi800-factors.js";
import {
  portfolioClassicDefinitions,
  portfolioClassicFactorMetadata,
  portfolioClassicIds,
} from "../src/portfolio-classics/index.js";
import { evaluateStrategy } from "../src/unified.js";
function report(
  reportDate: string,
  announcementDate: string,
  assets: number,
  revenue: number,
  cost: number,
  profit: number,
  cash: number,
): FinancialReportSnapshot {
  const raw = new Array<number>(658).fill(0);
  for (const [id, value] of [
    [40, assets],
    [74, revenue],
    [75, cost],
    [95, profit],
    [107, cash],
  ])
    raw[id! - 1] = value!;
  return {
    symbol: "sh600519",
    reportDate,
    announcementDate,
    availableFrom:
      announcementDate === "2024-04-30"
        ? "2024-05-06"
        : new Date(Date.parse(announcementDate) + 86400000)
            .toISOString()
            .slice(0, 10),
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
function history() {
  return [
    report("2024-06-30", "2024-08-30", 999999, 999999, 1, 999999, 1),
    report("2024-03-31", "2024-04-30", 1500, 300, 200, 40, 50),
    report("2023-12-31", "2024-04-01", 1000, 1000, 600, 110, 120),
    report("2023-03-31", "2023-04-28", 1100, 250, 150, 20, 80),
    report("2022-12-31", "2023-04-01", 900, 900, 500, 90, 100),
  ];
}
const asOf = "2024-05-06";
it("declares four distinct sources, existing feature keys, units and rank directions", () => {
  expect(new Set(portfolioClassicIds).size).toBe(4);
  expect(portfolioClassicDefinitions.map((d) => d.id)).toEqual(
    portfolioClassicIds,
  );
  expect(portfolioClassicFactorMetadata.grossProfitability).toMatchObject({
    sourceFeature: "gross-profit-assets",
    unit: "ratio",
    period: null,
    skip: 0,
    financialFields: [74, 75, 40],
  });
  expect(portfolioClassicFactorMetadata.cashAccrualQuality).toMatchObject({
    sourceFeature: "cash-quality",
    unit: "ratio",
    financialFields: [95, 107, 40],
  });
  expect(portfolioClassicFactorMetadata.assetGrowth).toMatchObject({
    sourceFeature: "asset-growth",
    unit: "ratio",
    financialFields: [40],
  });
  expect(
    portfolioClassicDefinitions.find(
      (d) => d.id === "portfolio-conservative-investment",
    )!.descending,
  ).toBe(false);
  expect(
    portfolioClassicDefinitions.find(
      (d) => d.id === "portfolio-profitability-value",
    )!.positiveFactors,
  ).toEqual(["bookToPrice"]);
  for (const definition of portfolioClassicDefinitions) {
    expect(definition.sources[0]).toContain(
      "9f053398c4995651d822e90d81526d0644c6f3e5",
    );
    expect(definition.rule.length).toBeGreaterThan(50);
    expect(definition.capabilities).toContain("point-in-time-financials");
  }
});
it("uses annual gross profit and same-year assets, TTM cash earnings and same-period YOY growth", () => {
  const value = classicFinancialFeatures(history(), asOf)!;
  expect(value.reportDate).toBe("2024-03-31");
  expect(
    value.values[
      portfolioClassicFactorMetadata.grossProfitability.sourceFeature
    ],
  ).toBeCloseTo(0.4, 12);
  expect(
    value.values[
      portfolioClassicFactorMetadata.cashAccrualQuality.sourceFeature
    ],
  ).toBeCloseTo((90 - 130) / 1500, 12);
  expect(
    value.values[portfolioClassicFactorMetadata.assetGrowth.sourceFeature],
  ).toBeCloseTo(400 / 1100, 12);
});
it("future announcements cannot alter features and announcement day itself is not yet visible", () => {
  const records = history();
  expect(classicFinancialFeatures(records, asOf)).toEqual(
    classicFinancialFeatures(records.slice(1), asOf),
  );
  expect(classicFinancialFeatures(records, "2024-04-30")!.reportDate).toBe(
    "2023-12-31",
  );
  const missing = records.map((r) => ({ ...r, availableFrom: null }));
  expect(classicFinancialFeatures(missing, asOf)).toBeNull();
});
it("keeps real losses and asset contraction, while rejecting missing periods and nonpositive denominators", () => {
  const records = history().slice(1);
  records[0]!.fields = records[0]!.fields.map((f) =>
    f.code === "FN40" ? { ...f, raw: 1000, value: 1000 } : f,
  );
  expect(
    classicFinancialFeatures(records, asOf)!.values["asset-growth"],
  ).toBeCloseTo(-100 / 1100, 12);
  records[1]!.fields = records[1]!.fields.map((f) =>
    f.code === "FN75" ? { ...f, raw: 1200, value: 1200 } : f,
  );
  expect(
    classicFinancialFeatures(records, asOf)!.values["gross-profit-assets"],
  ).toBeCloseTo(-0.2, 12);
  const withoutPeriod = records.filter((r) => r.reportDate !== "2023-03-31");
  const absent = classicFinancialFeatures(withoutPeriod, asOf)!;
  expect(absent.values["asset-growth"]).toBeNull();
  expect(absent.values["cash-quality"]).toBeNull();
  const zero = history()
    .slice(1)
    .map((r) => ({
      ...r,
      fields: r.fields.map((f) =>
        f.code === "FN40" ? { ...f, raw: -1, value: -1 } : f,
      ),
    }));
  const invalid = classicFinancialFeatures(zero, asOf)!;
  expect(invalid.values["gross-profit-assets"]).toBeNull();
  expect(invalid.values["cash-quality"]).toBeNull();
  expect(invalid.values["asset-growth"]).toBeNull();
});
it("declares exclusive growth bound while allowing economically valid contraction", () => {
  expect(portfolioClassicFactorMetadata.assetGrowth.exclusiveMinimum).toBe(-1);
  const output = evaluateStrategy(
    {
      strategyId: "portfolio-conservative-investment",
      parameters: { topK: 1 },
    },
    {
      asOf,
      candidates: [
        { symbol: "invalid", availableAt: asOf, values: { assetGrowth: -1.1 } },
        {
          symbol: "contracting",
          availableAt: asOf,
          values: { assetGrowth: -0.2 },
        },
      ],
    },
  );
  if (output.kind !== "weights") throw new Error("Expected shared weights");
  expect(output.weights).toEqual([{ symbol: "contracting", weight: 1 }]);
  expect(output.excluded).toContain("invalid");
});

it("does not apply ordinary gross profitability or cash-accrual quality to financial firms", () => {
  const value = classicFinancialFeatures(
    history().map((r) => ({ ...r, financialCompany: true })),
    asOf,
  )!;
  expect(value.values["gross-profit-assets"]).toBeNull();
  expect(value.values["cash-quality"]).toBeNull();
});
it("registered recipes share one real executor, stable ties, missing exclusion and negative-value ranking", () => {
  const candidates = [
    {
      symbol: "A",
      availableAt: asOf,
      values: {
        grossProfitability: -0.2,
        cashAccrualQuality: 0.3,
        assetGrowth: 0.1,
        bookToPrice: 0.2,
      },
    },
    {
      symbol: "B",
      availableAt: asOf,
      values: {
        grossProfitability: 0.4,
        cashAccrualQuality: -0.1,
        assetGrowth: -0.1,
        bookToPrice: 0.2,
      },
    },
    {
      symbol: "C",
      availableAt: asOf,
      values: {
        grossProfitability: 0.4,
        cashAccrualQuality: 0.1,
        assetGrowth: 0.4,
        bookToPrice: 0,
      },
    },
    {
      symbol: "D",
      availableAt: asOf,
      values: {
        grossProfitability: null,
        cashAccrualQuality: null,
        assetGrowth: null,
        bookToPrice: 0.2,
      },
    },
    {
      symbol: "E",
      availableAt: "2024-06-01",
      values: {
        grossProfitability: 999,
        cashAccrualQuality: 999,
        assetGrowth: -0.99,
        bookToPrice: 999,
      },
    },
  ];
  const expected: Record<string, string[]> = {
    "portfolio-gross-profitability": ["B", "C"],
    "portfolio-cash-accruals": ["A", "C"],
    "portfolio-conservative-investment": ["B", "A"],
    "portfolio-profitability-value": ["B", "A"],
  };
  for (const definition of portfolioClassicDefinitions) {
    const output = evaluateStrategy(
      { strategyId: definition.id, parameters: { topK: 2 } },
      { asOf, candidates },
    );
    if (output.kind !== "weights") throw new Error("Expected unified weights");
    expect(output.weights).toEqual(
      expected[definition.id]!.map((symbol) => ({ symbol, weight: 0.5 })),
    );
    expect(output.excluded).toContain("D");
    expect(output.excluded).toContain("E");
  }
});
it("empty common samples stay in cash, duplicate symbols and invalid asOf are rejected", () => {
  for (const definition of portfolioClassicDefinitions) {
    expect(
      evaluateStrategy({ strategyId: definition.id }, { asOf, candidates: [] }),
    ).toEqual({ kind: "weights", weights: [], excluded: [] });
    const candidate = {
      symbol: "A",
      availableAt: asOf,
      values: {
        grossProfitability: 0.2,
        cashAccrualQuality: 0.2,
        assetGrowth: 0.2,
        bookToPrice: 0.2,
      },
    };
    expect(() =>
      evaluateStrategy(
        { strategyId: definition.id },
        { asOf, candidates: [candidate, candidate] },
      ),
    ).toThrow();
    expect(() =>
      evaluateStrategy(
        { strategyId: definition.id },
        { asOf: "2024-02-30", candidates: [] },
      ),
    ).toThrow();
  }
});
it("preserves unmodified GPL research-source snapshots and full license outside runtime", () => {
  const base = new URL(
    "../../../docs/data-sources/portfolio-classics/open-source-ap/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    readFileSync(new URL("manifest.json", base), "utf8"),
  ) as {
    ref: string;
    license: string;
    files: { path: string; sha256: string }[];
  };
  expect(manifest.ref).toBe("9f053398c4995651d822e90d81526d0644c6f3e5");
  expect(manifest.license).toContain("GPL-2.0");
  for (const source of manifest.files) {
    const data = readFileSync(new URL(source.path.split("/").at(-1)!, base));
    expect(createHash("sha256").update(data).digest("hex")).toBe(source.sha256);
  }
  expect(readFileSync(new URL("LICENSE", base), "utf8")).toContain(
    "Version 2, June 1991",
  );
});
