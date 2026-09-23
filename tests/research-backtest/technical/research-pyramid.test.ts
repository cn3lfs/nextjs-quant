import { expect, it } from "vitest";
import type { Bar } from "../../../src/lib/domain";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../../../src/lib/research/strategy-research";
import type { ResearchExecutionRules } from "../../../src/lib/research/technical/research-execution";
import { researchPortfolio } from "../../../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
import {
  researchPlannedProceeds,
  researchPyramidOrder,
} from "../../../src/lib/research/technical/research-pyramid";
import {
  researchBookBuy,
  researchPositionBook,
} from "../../../src/lib/research/analysis/research-position-book";
import { projectResearchWeights } from "../../../src/lib/backtest/weight-backtest";

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
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[0]!,
  endpointDate: dates[0]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
};
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
function bars(
  opens = [100, 100, 105, 110, 115, 90],
  closes = [100, 105, 110, 115, 100, 91],
): Bar[] {
  return opens.map((open, i) => ({
    date: dates[i]!,
    open,
    close: closes[i]!,
    high: Math.max(open, closes[i]!) + 1,
    low: Math.min(open, closes[i]!) - 1,
    volume: 10000,
    amount: 1000000,
  }));
}
function run(
  input = bars(),
  config = spec,
  daily: (date: string) => ResearchExecutionRules = () => rules,
) {
  return researchPortfolio(
    config,
    [event],
    input.map((bar) => bar.date),
    new Map([[event.symbol, input]]),
    (_, date) => daily(date),
  );
}

it("executes 50/30/20 only after closed 1R/2R signals, freezes first R and accounts for a losing gap", () => {
  const result = run();
  const trade = result.trades[0]!;
  expect(
    trade.entries!.map((entry) => [
      entry.date,
      entry.triggerDate,
      entry.quantity,
      entry.price,
    ]),
  ).toEqual([
    [dates[1], dates[0], 500, 100],
    [dates[2], dates[1], 300, 105],
    [dates[3], dates[2], 200, 110],
  ]);
  expect(trade.quantity).toBe(500);
  expect(trade.plannedQuantity).toBe(1000);
  expect(trade.riskBudget).toBe(5000);
  expect(trade.entryCost).toBe(103500);
  expect(trade.book!.totalQuantity).toBe(1000);
  expect(trade.entries![1]!.stop).toBeCloseTo(101.875);
  expect(trade.entries![2]!.stop).toBeCloseTo(101.875);
  expect(trade.entries![2]!.plannedRisk).toBeCloseTo(1625);
  expect(trade.exitDate).toBe(dates[5]);
  expect(trade.profit).toBe(-13500);
  expect(result.nav.map((row) => row.value)).toEqual([
    200000, 202500, 206500, 211500, 196500, 186500,
  ]);
  expect(trade.netReturn).toBeCloseTo(-13500 / 103500);
  expect(trade.book!.remainingCost).toBe(0);
});

it("uses acquired-to-date quantities in historical weights, then FIFO costs for reductions", () => {
  const input = bars();
  const result = run(
    input,
    researchSpecSchema.parse({
      ...spec,
      management: {
        ...spec.management,
        scaleOut: [{ atR: 3, fraction: 1 / 3, raiseStopR: null }],
      },
    }),
  );
  const trade = result.trades[0]!;
  expect(trade.sales!.map((sale) => sale.quantity)).toEqual([300, 700]);
  expect(trade.profit).toBe(-6000);
  expect(trade.exitPrice).toBe(97.5);
  const weights = projectResearchWeights(
    result,
    new Map([[event.symbol, input]]),
  );
  expect(weights.rows.find((row) => row.dt === dates[1])!.weight).toBeCloseTo(
    (500 * 105) / 202500,
  );
  expect(weights.rows.find((row) => row.dt === dates[2])!.weight).toBeCloseTo(
    (800 * 110) / 206500,
  );
  expect(weights.rows.find((row) => row.dt === dates[4])!.weight).toBeCloseTo(
    (700 * 100) / 201000,
  );
});

it("gives reduction priority over a same-close add signal and never resumes additions", () => {
  const result = run(
    bars(),
    researchSpecSchema.parse({
      ...spec,
      management: {
        ...spec.management,
        scaleOut: [{ atR: 1, fraction: 0.2, raiseStopR: null }],
      },
    }),
  );
  expect(result.trades[0]!.entries).toHaveLength(1);
  expect(result.trades[0]!.sales![0]!.quantity).toBe(100);
});

it("does not average down, does not trigger from highs, and expires blocked additions", () => {
  const input = bars([100, 100, 99, 99, 99], [100, 105, 100, 100, 100]);
  const result = run(input, { ...spec, entryMaxWait: 1 });
  expect(result.trades[0]!.entries).toHaveLength(1);
  expect(result.attempts.some((row) => row.reason.includes("禁止摊低"))).toBe(
    true,
  );
  expect(
    result.trades[0]!.managementWarnings!.some((row) =>
      row.reason.includes("等待期结束"),
    ),
  ).toBe(true);
  expect(result.pendingAdditions).toEqual([]);
  const highOnly = bars([100, 100, 100], [100, 100, 100]).map((bar) => ({
    ...bar,
    high: 120,
  }));
  expect(run(highOnly).trades[0]!.entries).toHaveLength(1);
});

it("enforces total exposure again after an upward gap and retains pending intent on missing rules", () => {
  const input = bars([100, 100, 200], [100, 105, 201]);
  const result = run(input);
  expect(result.trades[0]!.entries).toHaveLength(2);
  expect(result.trades[0]!.entries![1]!.quantity).toBe(200);
  expect(result.trades[0]!.remainingQuantity! * 200).toBeLessThanOrEqual(
    250000 * 0.6,
  );
  const unavailable = run(bars().slice(0, 3), spec, (date) =>
    date === dates[2] ? { ...rules, minimumSell: undefined } : rules,
  );
  expect(unavailable.trades[0]!.entries).toHaveLength(1);
  expect(unavailable.pendingAdditions).toHaveLength(1);
});

it("estimates fees for each future sell chunk and requires independently complete sell rules", () => {
  const costs = { ...spec.costs, minimumCommission: 5, sellTaxBps: 10 };
  expect(
    researchPlannedProceeds(800, 100, { ...rules, maximumSell: 300 }, costs),
  ).toBe(79905);
  expect(
    researchPlannedProceeds(
      800,
      100,
      { ...rules, minimumSell: undefined },
      costs,
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
    rules,
    costs: spec.costs,
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
    rules: { ...rules, maximumSell: 300 },
    costs: { ...spec.costs, minimumCommission: 5, sellTaxBps: 10 },
  };
  const result = researchPyramidOrder(input);
  expect(result.order!.book.remainingCost).toBe(81510);
  expect(result.order!.stop).toBeCloseTo(81525 / (800 * 0.999));
  expect(result.order!.plannedRisk).toBeCloseTo(0);
  expect(researchPyramidOrder({ ...input, stop: 104 }).order!.stop).toBe(104);
  const holes = researchPyramidOrder({
    ...input,
    desired: 150,
    rules: { ...rules, minimumBuy: 50, buyStep: 50, sellOddLotAll: false },
  });
  expect(holes.order!.quantity).toBe(100);
});

it("does not bypass blocked fills or the longest holding deadline when adding", () => {
  const result = run(bars(), spec, (date) =>
    date === dates[2] ? { ...rules, limitUp: 105 } : rules,
  );
  expect(result.trades[0]!.entries![1]!.date).toBe(dates[3]);
  expect(
    result.attempts.some(
      (row) => row.side === "buy" && row.reason.includes("涨停"),
    ),
  ).toBe(true);
  const expired = run(bars(), { ...spec, holdingDays: 1 }, (date) =>
    date === dates[2] ? { ...rules, limitDown: 105 } : rules,
  );
  expect(expired.trades[0]!.entries).toHaveLength(1);
  expect(expired.pendingAdditions).toEqual([]);
});

it("includes all estimated exit-order fees in the first batch risk gate", () => {
  const result = run(
    bars(),
    { ...spec, costs: { ...spec.costs, minimumCommission: 100 } },
    () => ({ ...rules, minimumSell: 1, sellStep: 1, maximumSell: 1 }),
  );
  expect(result.trades).toEqual([]);
  expect(
    result.attempts.some((attempt) => attempt.reason.includes("分单退出费用")),
  ).toBe(true);
  const normal = run().trades[0]!;
  expect(normal.entries![0]!.plannedRisk).toBe(2500);
});
