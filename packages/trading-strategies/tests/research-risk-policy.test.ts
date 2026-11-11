import { expect, it } from "vitest";
import {
  plannedStopRisk,
  researchRiskQuantity,
} from "../src/research/risk/research-risk.js";
import {
  repairRaisedStop,
  repairReductionQuantity,
} from "../src/research/risk/research-risk-repair.js";
import {
  disciplineAddOnAllowed,
  disciplineStopTriggered,
} from "../src/research/risk/discipline-policy.js";
import type { ResearchExecutor } from "../src/research/contracts/executor.js";

const execution: ResearchExecutor = {
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  costs: { slippageBps: 10, sellTaxBps: 10 },
  buyQuantity: (cash, price) => Math.floor(cash / price / 100) * 100,
  sellQuantity: (request, held) => Math.min(request, held),
  commission: () => 5,
  bookBuy: () => {
    throw new Error("risk quantity must not modify a book");
  },
};
it("includes fees and slippage in stop risk while sizing from frozen capacity quotes", () => {
  expect(plannedStopRisk(100, 10, 9, execution)).toBeCloseTo(111.7991, 8);
  expect(
    researchRiskQuantity({
      cash: 100000,
      equity: 100000,
      price: 10,
      stop: 9,
      fraction: 0.001,
      maxWeight: 0.2,
      execution,
    }),
  ).toBe(0);
  expect(
    researchRiskQuantity({
      cash: 100000,
      equity: 100000,
      price: 10,
      stop: 9,
      fraction: 0.002,
      maxWeight: 0.2,
      execution,
    }),
  ).toBe(100);
});
it("finds the minimum protective raised line and minimum feasible reduction from quotes", () => {
  expect(
    repairRaisedStop(90, 100, 50, (price) => 1000 - price * 10),
  ).toBeCloseTo(95, 10);
  expect(repairRaisedStop(90, 94, 50, (price) => 1000 - price * 10)).toBeNull();
  expect(
    repairReductionQuantity({
      maximum: 100,
      minimum: 10,
      step: 10,
      price: 10,
      stop: 9,
      budget: 30,
      riskAfter: (quantity) => 100 - quantity,
    }),
  ).toBe(70);
});
it("distinguishes equality from a real stop breach and enforces add-on limits", () => {
  expect(disciplineStopTriggered(1000, 100, 9.5, 0.05)).toBe(false);
  expect(disciplineStopTriggered(1000, 100, 9.49, 0.05)).toBe(true);
  expect(disciplineAddOnAllowed(1, 2)).toBe(false);
  expect(disciplineAddOnAllowed(null, 100)).toBe(true);
});
