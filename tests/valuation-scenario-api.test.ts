import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaller } from "../src/server/api/root";
import { get, sqlite } from "../src/server/db";
import { valuationScenarioSchema } from "../src/lib/valuation-scenario";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-valuation-api-"),
);
const caller = createCaller({ headers: new Headers() });
function fixture() {
  return valuationScenarioSchema.parse({
    symbol: "sh600519",
    title: "人工算术对照",
    scenarios: [
      {
        name: "基准",
        assumptions: {
          method: "fcff-wacc",
          cashFlowBasis: "fcff",
          currency: "CNY",
          amountUnit: "yuan",
          sharesUnit: "shares",
          totalShares: 10,
          growthRate: 0,
          discountRate: 0.1,
          terminalGrowthRate: 0,
          forecastYears: 5,
          baseFcff: 100,
          cashAndNonOperatingAssets: 100,
          debtValue: 200,
          minorityInterestValue: 50,
          otherClaimsValue: 0,
          assumptionNote: "测试人工假设，并非财报事实",
        },
      },
    ],
  });
}
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  vi.restoreAllMocks();
});
it("archives independent scenarios with exact arithmetic and idempotent content identity", async () => {
  const input = fixture();
  input.scenarios.push({
    name: "高折现率",
    assumptions: { ...input.scenarios[0]!.assumptions, discountRate: 0.2 },
  });
  const first = await caller.valuationSave(input);
  expect(Object.keys(first)).toEqual(["id"]);
  const report = await caller.valuationReport(first.id);
  expect(report).toEqual(get(first.id));
  expect(report).toMatchObject({
    origin: "user-assumptions",
    financialEvidenceVerified: false,
    automaticSignals: false,
  });
  expect(report!.scenarios[0]!.perShareValue).toBeCloseTo(85);
  expect(report!.range.min).toBeCloseTo(35);
  expect(report!.range.max).toBeCloseTo(85);
  expect((await caller.valuationSave(input)).id).toBe(first.id);
  expect(await caller.valuationReport(first.id)).toEqual(report);
  input.scenarios[0]!.assumptions.assumptionNote = "修订依据";
  const revision = await caller.valuationSave(input);
  expect(revision.id).not.toBe(first.id);
  expect(await caller.valuationReport(first.id)).toEqual(report);
  const history = await caller.valuationHistory();
  expect(history).toHaveLength(2);
  expect(Object.keys(history[0]!).sort()).toEqual([
    "createdAt",
    "id",
    "method",
    "symbol",
    "title",
  ]);
});
it("rejects malformed, duplicate, mixed-method and divergent scenarios without partial persistence", async () => {
  const input = fixture();
  await expect(
    caller.valuationSave({
      ...input,
      scenarios: [input.scenarios[0]!, input.scenarios[0]!],
    }),
  ).rejects.toThrow("重复");
  await expect(
    caller.valuationSave({ ...input, scenarios: [] }),
  ).rejects.toThrow();
  await expect(
    caller.valuationSave({
      ...input,
      scenarios: Array.from({ length: 4 }, (_, i) => ({
        ...input.scenarios[0]!,
        name: String(i),
      })),
    }),
  ).rejects.toThrow();
  const bad = structuredClone(input.scenarios[0]!);
  bad.name = "发散";
  bad.assumptions.terminalGrowthRate = bad.assumptions.discountRate;
  await expect(
    caller.valuationSave({ ...input, scenarios: [...input.scenarios, bad] }),
  ).rejects.toThrow("严格高于");
  const guo = {
    name: "重构",
    assumptions: {
      currency: "CNY",
      amountUnit: "yuan",
      sharesUnit: "shares",
      totalShares: 10,
      growthRate: 0,
      discountRate: 0.1,
      terminalGrowthRate: 0,
      assumptionNote: "独立重构算例",
      method: "guo-operating-equity",
      cashFlowBasis: "operating-cash-flow-less-maintenance",
      forecastYears: 5,
      operatingCashFlow: 150,
      maintenanceCapex: 50,
      financialAssetsValue: 100,
      longTermInvestmentsValue: 200,
      interestBearingDebt: 300,
      minorityEquity: 20,
      totalEquity: 100,
    },
  };
  const separate = valuationScenarioSchema.parse({
    ...input,
    scenarios: [guo],
  });
  await expect(
    caller.valuationSave({
      ...input,
      scenarios: [...input.scenarios, ...separate.scenarios],
    }),
  ).rejects.toThrow("分别保存");
  expect(await caller.valuationHistory()).toEqual([]);
  const saved = await caller.valuationSave(separate);
  expect(
    (await caller.valuationReport(saved.id))!.scenarios[0]!.perShareValue,
  ).toBeCloseTo(80);
});
it("returns absent archives explicitly and rejects unrelated record identifiers", async () => {
  expect(
    await caller.valuationReport(`valuation-scenario-${"0".repeat(64)}`),
  ).toBeNull();
  await expect(caller.valuationReport("settings")).rejects.toThrow();
});
