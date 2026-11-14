import { expect, it } from "vitest";
import {
  displayFinancialNumber,
  displayFinancialMetric,
  displayFinancialRatio,
  displayAnnualFinancialRatio,
} from "../../../src/lib/financial/financial-display";

it("distinguishes fractions, percent points and multiples without changing inputs", () => {
  const debt = Object.freeze({ id: "debt-ratio", value: 0.119, unit: "比例" });
  expect(displayFinancialMetric(debt)).toBe("11.90%");
  expect(debt.value).toBe(0.119);
  expect(displayFinancialRatio(0.119)).toBe("11.90%");
  expect(displayFinancialMetric({ id: "74-yoy", value: 11.9, unit: "%" })).toBe(
    "11.90%",
  );
  expect(
    displayFinancialMetric({ id: "net-margin", value: -0.119, unit: "比例" }),
  ).toBe("-11.90%");
  expect(
    displayFinancialMetric({ id: "current-ratio", value: 1.19, unit: "比例" }),
  ).toBe("1.19倍");
  expect(
    displayFinancialMetric({ id: "cash-to-profit", value: 1.19, unit: "比例" }),
  ).toBe("1.19倍");
  expect(
    displayFinancialMetric({ id: "unclassified", value: 0.119, unit: "比例" }),
  ).toBe("0.119 比例");
  expect(displayFinancialNumber(11.91234, "%")).toBe("11.9123");
});

it("formats annual ratios by their financial meaning, retaining absent values", () => {
  for (const key of [
    "netMargin",
    "roe",
    "reportedProfitRoa",
    "grossMargin",
    "cashReturnOnOpeningAssets",
  ])
    expect(displayAnnualFinancialRatio(key, 0.119)).toBe("11.90%");
  for (const key of ["currentRatio", "cashToProfit", "equityMultiplier"])
    expect(displayAnnualFinancialRatio(key, 1.19)).toBe("1.19倍");
  expect(displayAnnualFinancialRatio("assetTurnover", 1.19)).toBe("1.19次");
  for (const value of [null, NaN, Infinity, -Infinity]) {
    expect(displayFinancialRatio(value)).toBe("—");
    expect(
      displayFinancialMetric({ id: "debt-ratio", value, unit: "比例" }),
    ).toBe("—");
    expect(displayAnnualFinancialRatio("cashToProfit", value)).toBe("—");
  }
  expect(displayFinancialRatio(0)).toBe("0.00%");
  expect(displayFinancialRatio(Number.MAX_VALUE)).toBe("—");
});

it("scales only monetary metrics for the selected display unit", () => {
  const cash = { id: "free-cash-flow", value: 123456789, unit: "元" };
  expect(displayFinancialMetric(cash)).toBe("123,456,789 元");
  expect(displayFinancialMetric(cash, "万元")).toBe("12,345.6789 万元");
  expect(displayFinancialMetric(cash, "亿元")).toBe("1.2346 亿元");
  expect(
    displayFinancialMetric(
      { id: "debt-ratio", value: 0.119, unit: "比例" },
      "亿元",
    ),
  ).toBe("11.90%");
});
