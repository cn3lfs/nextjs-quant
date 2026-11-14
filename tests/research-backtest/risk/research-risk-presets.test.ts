import {
  researchCostQuote,
  researchExecutor,
} from "~/lib/backtest/research-executor";
import { riskDisasterTriggered } from "trading-strategies/research/risk/research-risk-presets";
import { riskPresetInitialStop } from "trading-strategies/research/risk/research-risk-presets";
import { expect, it } from "vitest";
import {
  riskPresetIds,
  riskPresetParameters,
  riskPresetBudget,
} from "trading-strategies/research/risk/research-risk-presets";
import { researchRiskQuantity } from "trading-strategies/research/risk/research-risk";
import type { Bar } from "../../../src/lib/domain";
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
it("initial/current equity controls diverge after losses without changing current market-value cap", () => {
  expect(
    riskPresetBudget(
      "rk-equity-current",
      100000,
      80000,
      [],
      researchCostQuote(costs),
    ),
  ).toBe(0.01);
  expect(
    riskPresetBudget(
      "rk-equity-initial",
      100000,
      80000,
      [],
      researchCostQuote(costs),
    ),
  ).toBe(0.0125);
  expect(
    riskPresetBudget(
      "rk-equity-current",
      100000,
      NaN,
      [],
      researchCostQuote(costs),
    ),
  ).toBeNull();
  // 20% of current 80,000 remains 16,000, even with initial risk budget.
  expect(
    researchRiskQuantity({
      cash: 80000,
      equity: 80000,
      price: 10,
      stop: 9.5,
      fraction: 0.0125,
      maxWeight: 0.2,
      execution: researchExecutor(rules, costs),
    }),
  ).toBe(1600);
});
it("aggregate risk consumes costs, never nets protected profits against other losses, and fails closed", () => {
  const held = [
    { quantity: 1000, entry: 10, stop: 7 },
    { quantity: 1000, entry: 10, stop: 12 },
  ];
  expect(
    riskPresetBudget(
      "rk-total4",
      100000,
      100000,
      held,
      researchCostQuote(costs),
    ),
  ).toBe(0.01);
  expect(
    riskPresetBudget(
      "rk-total4",
      100000,
      80000,
      held,
      researchCostQuote(costs),
    ),
  ).toBe(0.0025);
  expect(
    riskPresetBudget(
      "rk-total6",
      100000,
      80000,
      held,
      researchCostQuote(costs),
    ),
  ).toBe(0.01);
  expect(
    riskPresetBudget(
      "rk-total4",
      100000,
      75000,
      held,
      researchCostQuote(costs),
    ),
  ).toBe(0);
  expect(
    riskPresetBudget(
      "rk-total4",
      100000,
      100000,
      [{ quantity: 100, entry: 10, stop: null }],
      researchCostQuote(costs),
    ),
  ).toBeNull();
  expect(
    riskPresetBudget(
      "rk-total4",
      100000,
      80000,
      held,
      researchCostQuote({
        ...costs,
        minimumCommission: 5,
      }),
    ),
  ).toBeCloseTo(0.002375, 12);
});
it("source no-cost A/B sizing examples remain exact and five risk tiers are independent", () => {
  expect(
    researchRiskQuantity({
      cash: 1000000,
      equity: 1000000,
      price: 80,
      stop: 75.8,
      fraction: 0.01,
      maxWeight: 0.2,
      execution: researchExecutor(rules, costs),
    }),
  ).toBe(2300);
  expect(
    researchRiskQuantity({
      cash: 1000000,
      equity: 1000000,
      price: 25,
      stop: 24.4,
      fraction: 0.01,
      maxWeight: 0.2,
      execution: researchExecutor(rules, costs),
    }),
  ).toBe(8000);
  expect(
    ["rk-risk025", "rk-risk05", "rk-risk1", "rk-risk15", "rk-risk2"].map(
      (id) =>
        riskPresetParameters(id as (typeof riskPresetIds)[number]).fraction,
    ),
  ).toEqual([0.0025, 0.005, 0.01, 0.015, 0.02]);
});
const input = (closes: number[]): Bar[] =>
  closes.map((close, i) => ({
    date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: Math.max(100, close) + 1,
    low: Math.min(100, close) - 1,
    close,
    volume: 10000,
    amount: 1000000,
  }));
it("ATR price bands preserve both exact boundaries and reject missing ATR", () => {
  const stop = (a: number | null) =>
    riskPresetInitialStop("rk-atr-bands", 100, { stopAtr: a });
  expect([stop(1.49), stop(1.5), stop(3), stop(3.01)]).toEqual([
    97, 95, 95, 92,
  ]);
  expect(stop(null)).toBeNull();
  expect(stop(0)).toBeNull();
});
it("farther structure/volatility stop widens initial risk and therefore reduces quantity", () => {
  expect(
    riskPresetInitialStop("rk-structure-farther", 100, {
      initialStop: 95,
      stopAtr: 2,
    }),
  ).toBe(94.4);
  expect(
    riskPresetInitialStop("rk-structure-farther", 100, {
      initialStop: 99,
      stopAtr: 2,
    }),
  ).toBe(96);
  expect(
    riskPresetInitialStop("rk-structure-farther", 100, {
      initialStop: 101,
      stopAtr: 2,
    }),
  ).toBeNull();
  const q = (stop: number) =>
    researchRiskQuantity({
      cash: 100000,
      equity: 100000,
      price: 100,
      stop,
      fraction: 0.01,
      maxWeight: 1,
      execution: researchExecutor(rules, costs),
    });
  expect(q(94.4)).toBeLessThan(q(96));
});
it("disaster input refuses illegal OHLC/zero volume rather than manufacturing a trigger", () => {
  const bar = input([100])[0]!;
  bar.low = 90;
  expect(riskDisasterTriggered(bar, 100, 95, "2r")).toBe(true);
  expect(riskDisasterTriggered({ ...bar, high: 89 }, 100, 95, "2r")).toBeNull();
  expect(
    riskDisasterTriggered({ ...bar, volume: 0 }, 100, 95, "2r"),
  ).toBeNull();
});
