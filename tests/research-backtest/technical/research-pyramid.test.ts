import { researchExecutor } from "~/lib/backtest/research-executor";
import { expect, it } from "vitest";
import { researchSpecSchema } from "../../../src/lib/research/strategy-research";
import type { ExecutionRules as ResearchExecutionRules } from "quant-backtest/execution";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
import {
  researchPlannedProceeds,
  researchPyramidOrder,
} from "trading-strategies/research/technical/research-pyramid";
import {
  researchBookBuy,
  researchPositionBook,
} from "../../../src/lib/research/analysis/research-position-book";
const dates = Array.from(
  { length: 8 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[7],
  validationStart: dates[6],
  initialCapital: 200000,
  holdingDays: 60,
  risk: { fraction: 0.025, maxWeight: 0.8 },
  management: { pyramid: { kind: "r-50-30-20", maxTotalWeight: 0.6 } },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const rules: ResearchExecutionRules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 10000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 10000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
it("estimates fees for each future sell chunk and requires independently complete sell rules", () => {
  const costs = { ...spec.costs, minimumCommission: 5, sellTaxBps: 10 };
  expect(
    researchPlannedProceeds(
      800,
      100,
      researchExecutor({ ...rules, maximumSell: 300 }, costs),
    ),
  ).toBe(79905);
  expect(
    researchPlannedProceeds(
      800,
      100,
      researchExecutor({ ...rules, minimumSell: undefined }, costs),
    ),
  ).toBeNull();
});
it("preserves old optional shapes and binds the pyramid source and version", () => {
  expect(
    researchSpecSchema.parse({ ...spec, management: {} }).management,
  ).not.toHaveProperty("pyramid");
  expect(
    researchSpecSchema.safeParse({
      ...spec,
      management: { pyramid: { kind: "r-50-30-20", maxTotalWeight: 2 } },
    }).success,
  ).toBe(false);
  const method = researchMethodSnapshot(spec);
  expect(method.pyramid!.version).toBe("research-pyramid-1");
  expect(
    method.sources.some(
      (source) =>
        source.path === "swing-trader/references/position-management.md",
    ),
  ).toBe(true);
  expect(method.hash).not.toBe(
    researchMethodSnapshot({ ...spec, management: undefined }).hash,
  );
});
it("recomputes remaining-book risk after additions and sizes down instead of enlarging its budget", () => {
  let book = researchBookBuy(researchPositionBook(), {
    date: dates[1]!,
    quantity: 500,
    price: 100,
    commission: 0,
  });
  book = researchBookBuy(book, {
    date: dates[2]!,
    quantity: 300,
    price: 105,
    commission: 0,
  });
  const result = researchPyramidOrder({
    book,
    date: dates[3]!,
    price: 110,
    desired: 200,
    stage: 1,
    stop: 101.875,
    firstPrice: 100,
    stressBuffer: 0,
    cash: 100000,
    equity: 200000,
    otherValue: 0,
    riskBudget: 1000,
    maxWeight: 0.8,
    maxTotalWeight: 0.6,
    execution: researchExecutor(rules, spec.costs),
  });
  expect(result.order!.quantity).toBe(100);
  expect(result.order!.stop).toBe(101.875);
  expect(result.order!.plannedRisk).toBe(812.5);
  expect(book.remainingQuantity).toBe(800);
});
it("includes actual buy fees and per-chunk exit fees in breakeven, and handles holes in sell quantities", () => {
  const book = researchBookBuy(researchPositionBook(), {
    date: dates[1]!,
    quantity: 500,
    price: 100,
    commission: 5,
  });
  const input = {
    book,
    date: dates[2]!,
    price: 105,
    desired: 300,
    stage: 0,
    stop: 95,
    firstPrice: 100,
    stressBuffer: 0,
    cash: 100000,
    equity: 200000,
    otherValue: 0,
    riskBudget: 5000,
    maxWeight: 0.8,
    maxTotalWeight: 0.6,
    execution: researchExecutor(
      { ...rules, maximumSell: 300 },
      { ...spec.costs, minimumCommission: 5, sellTaxBps: 10 },
    ),
  };
  const result = researchPyramidOrder(input);
  expect(result.order!.book.remainingCost).toBe(81510);
  expect(result.order!.stop).toBeCloseTo(81525 / (800 * 0.999));
  expect(result.order!.plannedRisk).toBeCloseTo(0);
  expect(researchPyramidOrder({ ...input, stop: 104 }).order!.stop).toBe(104);
  const holes = researchPyramidOrder({
    ...input,
    desired: 150,
    execution: researchExecutor(
      { ...rules, minimumBuy: 50, buyStep: 50, sellOddLotAll: false },
      { ...spec.costs, minimumCommission: 5, sellTaxBps: 10 },
    ),
  });
  expect(holes.order!.quantity).toBe(100);
});
