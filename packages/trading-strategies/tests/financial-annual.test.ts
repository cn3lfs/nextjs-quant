import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type {
  FinancialAnnualInput,
  FinancialAnnualKey,
  AnnualAmount,
} from "../src/research/contracts/financial-annual.js";
import { financialQualityFromAnnual } from "../src/research/value/financial-quality.js";
import { financialGrowthFromFacts } from "../src/research/value/financial-growth.js";

function amount(
  field: FinancialAnnualKey,
  value: number,
  index: number,
): AnnualAmount {
  return {
    value,
    currency: "CNY",
    points: [
      {
        field,
        raw: value,
        rawUnit: "人民币元",
        value,
        currency: "CNY",
        reasons: [],
        evidenceId: `source-${index}`,
      },
    ],
    reasons: [],
  };
}
function fixture(): FinancialAnnualInput {
  const values = [
    [100, 60, 10, 9, 1, 200, 100, 50, 30, 12],
    [110, 65, 12, 11, 1, 220, 110, 60, 30, 15],
    [121, 70, 14.4, 13.4, 1, 240, 120, 70, 30, 18],
    [133.1, 75, 17.28, 16.28, 1, 260, 130, 80, 30, 20],
  ];
  return {
    annual: values.map((row, index) => ({
      period: `${2022 + index}1231`,
      amountUnit: "yuan",
      amounts: {
        revenue: amount("revenue", row[0]!, index),
        operatingCost: amount("operatingCost", row[1]!, index),
        netProfit: amount("netProfit", row[2]!, index),
        parentProfit: amount("parentProfit", row[3]!, index),
        minorityProfit: amount("minorityProfit", row[4]!, index),
        assets: amount("assets", row[5]!, index),
        equity: amount("equity", row[6]!, index),
        currentAssets: amount("currentAssets", row[7]!, index),
        currentLiabilities: amount("currentLiabilities", row[8]!, index),
        operatingCashFlow: amount("operatingCashFlow", row[9]!, index),
      },
    })),
    rejected: [],
  };
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("preserves the original annual JSON and application growth identity byte for byte", () => {
  // Characterized against the pre-extraction implementation in HEAD, not regenerated from this module.
  const quality = financialQualityFromAnnual("sh600519", fixture());
  expect(hash(quality)).toBe(
    "a4a88dc884d9b7d35af3736a24d6bc47562df255bb76bbbfaee5af3058db25fa",
  );
  const growth = financialGrowthFromFacts(quality, "source-archive");
  expect(growth).not.toHaveProperty("id");
  const archived = { id: `financial-growth-${hash(growth)}`, ...growth };
  expect(archived.id).toBe(
    "financial-growth-14eaebf03012aac3314a93b9d06da3d729d4a7782de38fe54f99e7799668eb39",
  );
  expect(hash(archived)).toBe(
    "c4517be200cf9a35dc2fa5fec839083fa274bd98442477c4e905c1248fa8a839",
  );
});

it("uses average balances for DuPont and keeps five unsupported F-score items unknown", () => {
  const result = financialQualityFromAnnual("sh600519", fixture());
  const row = result.annual.at(-1)!;
  expect(row.averageAssets.value).toBe(250);
  expect(row.averageEquity.value).toBe(125);
  expect(row.ratios.roe.value).toBeCloseTo(17.28 / 125);
  expect(row.ratios.roe.citations).toEqual(["source-3", "source-2"]);
  expect(result.fScore).toMatchObject({
    total: null,
    knownCount: 4,
    knownPoints: 4,
  });
  expect(
    result.fScore.items.filter((item) => item.point === null),
  ).toHaveLength(5);
});

it("never hides a conflicting consolidated profit behind available component values", () => {
  const input = fixture(),
    latest = input.annual.at(-1)!;
  latest.amounts.netProfit.value = null;
  latest.amounts.netProfit.reasons = ["conflicting observations"];
  expect(
    financialQualityFromAnnual("sh600519", input).annual.at(-1)!.netProfit
      .value,
  ).toBeNull();
  latest.amounts.netProfit.points = [];
  expect(
    financialQualityFromAnnual("sh600519", input).annual.at(-1)!.netProfit
      .value,
  ).toBeCloseTo(17.28);
});

it("does not combine currency bases or replace an absent adjacent year", () => {
  const input = fixture();
  input.annual.at(-1)!.amounts.assets.currency = null;
  const mismatch = financialQualityFromAnnual("sh600519", input).annual.at(-1)!;
  expect(mismatch.averageAssets.value).toBeNull();
  expect(mismatch.averageAssets.missing).toContain(
    "字段币种标记不一致，不能合并计算",
  );
  input.annual.splice(2, 1);
  const facts = financialQualityFromAnnual("sh600519", input);
  expect(facts.annual.at(-1)!.averageAssets.value).toBeNull();
  expect(
    financialGrowthFromFacts(facts, "source").threeYear.revenueCagr.value,
  ).toBeNull();
});

it("requires four consecutive year ends for three-year CAGR and three positive annual changes", () => {
  const input = fixture(),
    result = financialGrowthFromFacts(
      financialQualityFromAnnual("sh600519", input),
      "source",
    );
  expect(result.threeYear.revenueCagr.value).toBeCloseTo(0.1);
  expect(result.threeYear.profitCagr.value).toBeCloseTo(0.2);
  expect(result.revenuePositiveThreeYears.value).toBe(true);
  input.annual.shift();
  const short = financialGrowthFromFacts(
    financialQualityFromAnnual("sh600519", input),
    "source",
  );
  expect(short.threeYear.revenueCagr.value).toBeNull();
  expect(short.revenuePositiveThreeYears.value).toBeNull();
});

it("preserves losses and zero endpoints without taking absolute bases", () => {
  const facts = financialQualityFromAnnual("sh600519", fixture());
  [-2, 0, 2, -1].forEach((value, index) => {
    facts.annual[index]!.netProfit.value = value;
  });
  let result = financialGrowthFromFacts(facts, "source");
  expect(result.annual.map((row) => row.profitYoy.value)).toEqual([
    null,
    null,
    null,
    -1.5,
  ]);
  expect(result.threeYear.profitCagr.value).toBeNull();
  facts.annual[0]!.netProfit.value = 10;
  facts.annual[3]!.netProfit.value = 0;
  result = financialGrowthFromFacts(facts, "source");
  expect(result.threeYear.profitCagr.value).toBe(-1);
});

it("uses logarithmic CAGR to avoid unnecessary ratio overflow and rejects mixed yearly currencies", () => {
  const facts = financialQualityFromAnnual("sh600519", fixture());
  [1e-250, 1, 1, 1e250].forEach((value, index) => {
    facts.annual[index]!.amounts.revenue.value = value;
  });
  const result = financialGrowthFromFacts(facts, "source");
  expect(result.threeYear.revenueCagr.value).toBeGreaterThan(1e166);
  expect(result.threeYear.revenueCagr.value).toBeLessThan(1e167);
  facts.annual[3]!.amounts.revenue.currency = null;
  expect(
    financialGrowthFromFacts(facts, "source").threeYear.revenueCagr.missing,
  ).toContain("各年度币种标记不一致，不能跨口径计算");
});

it("does not read the clock or mutate normalized inputs, including rejected evidence", () => {
  const input = fixture();
  input.rejected.push({
    field: "revenue[20250930]",
    evidenceId: "quarter",
    reason: "not annual",
  });
  const before = structuredClone(input);
  const clock = vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("Annual mathematics must not read the ambient clock");
  });
  try {
    const facts = financialQualityFromAnnual("sh600519", input);
    const saved = structuredClone(facts);
    financialGrowthFromFacts(facts, "source");
    expect(input).toEqual(before);
    expect(facts).toEqual(saved);
    expect(facts.rejected).toEqual(input.rejected);
  } finally {
    clock.mockRestore();
  }
});
