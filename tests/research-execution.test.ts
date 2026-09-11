import { expect, it } from "vitest";
import {
  researchBuyQuantity,
  researchFill,
  type ResearchExecutionRules,
} from "../src/lib/research-execution";
import { defaultBacktestCosts } from "../src/lib/backtest-costs";

const rules: ResearchExecutionRules = {
  evidence: "test-day-rules",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  limitUp: 11,
  limitDown: 9,
  tradable: true,
};
const bar = {
  date: "2024-01-02",
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 1000,
  amount: 10000,
};
it("accounts for minimum commissions and distinct STAR quantity increments", () => {
  expect(researchBuyQuantity(1000, 10, rules, defaultBacktestCosts)).toBe(0);
  expect(researchBuyQuantity(1005, 10, rules, defaultBacktestCosts)).toBe(100);
  expect(
    researchBuyQuantity(
      2515,
      10,
      { ...rules, minimumBuy: 200, buyStep: 1 },
      defaultBacktestCosts,
    ),
  ).toBe(251);
});
it("does not assume fills through suspension, missing rules or opening limit queues", () => {
  expect(researchFill(bar, "buy", null, defaultBacktestCosts).price).toBeNull();
  expect(
    researchFill({ ...bar, open: 11 }, "buy", rules, defaultBacktestCosts)
      .reason,
  ).toContain("涨停");
  expect(
    researchFill({ ...bar, open: 9 }, "sell", rules, defaultBacktestCosts)
      .reason,
  ).toContain("跌停");
  expect(
    researchFill({ ...bar, volume: 0 }, "buy", rules, defaultBacktestCosts)
      .price,
  ).toBeNull();
  expect(
    researchFill(bar, "buy", rules, defaultBacktestCosts).price,
  ).toBeCloseTo(10.005);
});
