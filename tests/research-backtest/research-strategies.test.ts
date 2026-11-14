import {
  researchCostQuote,
  researchExecutor,
} from "~/lib/backtest/research-executor";
import { expect, it } from "vitest";
import {
  plannedStopRisk,
  researchRiskQuantity,
} from "trading-strategies/research/risk/research-risk";
import { backtestCostsSchema } from "../../src/lib/backtest/backtest-costs";
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
it("includes both minimum commissions and sell tax in the risk cap, then rounds down to valid lots", () => {
  const costs = backtestCostsSchema.parse({ slippageBps: 0 });
  const quantity = researchRiskQuantity({
    cash: 10000,
    equity: 10000,
    price: 10,
    stop: 9,
    fraction: 0.05,
    maxWeight: 1,
    execution: researchExecutor(rules, costs),
  });
  // 400 * (10-9) + 5 + 5 + 400*9*0.0005 = 411.8; the next lot costs 512.25 risk.
  expect(quantity).toBe(400);
  expect(
    plannedStopRisk(quantity, 10, 9, researchCostQuote(costs)),
  ).toBeCloseTo(411.8);
  expect(
    plannedStopRisk(quantity + 100, 10, 9, researchCostQuote(costs)),
  ).toBeGreaterThan(500);
  expect(
    researchRiskQuantity({
      cash: 10000,
      equity: 10000,
      price: 10,
      stop: 9,
      fraction: 0.001,
      maxWeight: 1,
      execution: researchExecutor(rules, costs),
    }),
  ).toBe(0);
  expect(
    researchRiskQuantity({
      cash: 10000,
      equity: 10000,
      price: 10,
      stop: 11,
      fraction: 0.05,
      maxWeight: 1,
      execution: researchExecutor(rules, costs),
    }),
  ).toBe(0);
});
