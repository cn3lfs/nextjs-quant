import { expect, it } from "vitest";
import { calculateValuation } from "~/lib/valuation";
const fcff = {
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
  assumptionNote: "固定现金流人工算例；不是证券估值结论",
};
it("separates FCFF operating value from parent per-share value with an explicit bridge", () => {
  const before = structuredClone(fcff);
  const result = calculateValuation(fcff);
  expect(result.operatingPresentValue).toBeCloseTo(1000, 10);
  expect(result.bridge.parentEquityValue).toBeCloseTo(850, 10);
  expect(result.perShareValue).toBeCloseTo(85, 10);
  expect(result.schedule.map((row) => row.cashFlow)).toEqual([
    100, 100, 100, 100, 100,
  ]);
  expect(result.terminalValue).toBe(1000);
  expect(result.automaticSignals).toBe(false);
  expect(fcff).toEqual(before);
  expect(
    calculateValuation({ ...fcff, debtValue: 2000 }).perShareValue,
  ).toBeLessThan(0);
});
it("keeps Guo cash-flow and ownership formulas independent from FCFF/WACC", () => {
  const result = calculateValuation({
    method: "guo-operating-equity",
    cashFlowBasis: "operating-cash-flow-less-maintenance",
    currency: "CNY",
    amountUnit: "yuan",
    sharesUnit: "shares",
    totalShares: 10,
    growthRate: 0,
    discountRate: 0.1,
    terminalGrowthRate: 0,
    forecastYears: 5,
    operatingCashFlow: 150,
    maintenanceCapex: 50,
    financialAssetsValue: 100,
    longTermInvestmentsValue: 200,
    interestBearingDebt: 300,
    minorityEquity: 20,
    totalEquity: 100,
    assumptionNote: "独立重构法算例",
  });
  expect(result.baseCashFlow).toBe(100);
  expect(result.operatingPresentValue).toBeCloseTo(1000, 10);
  expect(result.bridge).toMatchObject({ parentShare: 0.8 });
  expect(result.perShareValue).toBeCloseTo(80, 10);
  expect(() =>
    calculateValuation({ ...result.input, minorityEquity: 101 }),
  ).toThrow("少数股东");
  expect(() =>
    calculateValuation({ ...result.input, maintenanceCapex: 150 }),
  ).toThrow("正的基期");
  expect(() => calculateValuation({ ...result.input, debtValue: 1 })).toThrow();
});
it("rejects missing assumptions, wrong units, divergent terminal values and arithmetic overflow", () => {
  for (const patch of [
    { discountRate: 0.02, terminalGrowthRate: 0.02 },
    { discountRate: 0.01, terminalGrowthRate: 0.02 },
    { totalShares: 0 },
    { amountUnit: "万元" },
    { growthRate: -1 },
    { assumptionNote: "" },
    { baseFcff: NaN },
    { baseFcff: Infinity },
    { baseFcff: Number.MAX_VALUE, growthRate: 1 },
    { cashFlowBasis: "ocf-minus-capex" },
    { minorityInterestValue: undefined },
  ])
    expect(() => calculateValuation({ ...fcff, ...patch })).toThrow();
});
it("reflects growth and discount assumptions without rounding or averaging scenarios", () => {
  const base = calculateValuation(fcff);
  const growing = calculateValuation({ ...fcff, growthRate: 0.1 });
  expect(growing.schedule[0]!.cashFlow).toBeCloseTo(110, 12);
  expect(growing.perShareValue).toBeGreaterThan(base.perShareValue);
  expect(
    calculateValuation({ ...fcff, discountRate: 0.12 }).perShareValue,
  ).toBeLessThan(base.perShareValue);
  expect(
    calculateValuation({ ...fcff, growthRate: -0.1 }).perShareValue,
  ).toBeLessThan(base.perShareValue);
});
