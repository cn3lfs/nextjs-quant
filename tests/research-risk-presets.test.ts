import { expect, it } from "vitest";
import {
  riskPresetIds,
  riskPresetParameters,
  riskPresetTemplate,
  riskPresetBudget,
} from "../src/lib/research-risk-presets";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchRiskQuantity } from "../src/lib/research-risk";
import type { Bar } from "../src/lib/domain";

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
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2021-01-01",
  end: "2021-03-01",
  validationStart: "2021-02-20",
  holdingDays: 60,
  initialCapital: 100000,
  costs,
});
it.each(riskPresetIds)(
  "%s freezes independent baseline, sizing and management",
  (id) => {
    const management = riskPresetTemplate(id);
    expect(researchManagementSchema.parse(management)).toEqual(management);
    const spec = applyResearchManagement(base, management);
    const p = riskPresetParameters(id);
    expect(researchSpecSchema.parse(spec).risk).toEqual({
      fraction: p.fraction,
      maxWeight: p.maxWeight,
    });
    expect(
      researchSpecSchema.safeParse({
        ...spec,
        risk: { fraction: 0.03, maxWeight: p.maxWeight },
      }).success,
    ).toBe(false);
    expect(
      researchManagementSchema.safeParse({
        ...management,
        pyramid: { kind: "r-50-30-20", maxTotalWeight: 1 },
      }).success,
    ).toBe(false);
  },
);
it("initial/current equity controls diverge after losses without changing current market-value cap", () => {
  expect(riskPresetBudget("rk-equity-current", 100000, 80000, [], costs)).toBe(
    0.01,
  );
  expect(riskPresetBudget("rk-equity-initial", 100000, 80000, [], costs)).toBe(
    0.0125,
  );
  expect(
    riskPresetBudget("rk-equity-current", 100000, NaN, [], costs),
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
      rules,
      costs,
    }),
  ).toBe(1600);
});
it("aggregate risk consumes costs, never nets protected profits against other losses, and fails closed", () => {
  const held = [
    { quantity: 1000, entry: 10, stop: 7 },
    { quantity: 1000, entry: 10, stop: 12 },
  ];
  expect(riskPresetBudget("rk-total4", 100000, 100000, held, costs)).toBe(0.01);
  expect(riskPresetBudget("rk-total4", 100000, 80000, held, costs)).toBe(
    0.0025,
  );
  expect(riskPresetBudget("rk-total6", 100000, 80000, held, costs)).toBe(0.01);
  expect(riskPresetBudget("rk-total4", 100000, 75000, held, costs)).toBe(0);
  expect(
    riskPresetBudget(
      "rk-total4",
      100000,
      100000,
      [{ quantity: 100, entry: 10, stop: null }],
      costs,
    ),
  ).toBeNull();
  expect(
    riskPresetBudget("rk-total4", 100000, 80000, held, {
      ...costs,
      minimumCommission: 5,
    }),
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
      rules,
      costs,
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
      rules,
      costs,
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
function run(id: (typeof riskPresetIds)[number], bars: Bar[]) {
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: "risk",
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
    stopAtr: 2,
  };
  return researchPortfolio(
    applyResearchManagement(base, riskPresetTemplate(id)),
    [event],
    bars.map((b) => b.date),
    new Map([[event.symbol, bars]]),
    () => rules,
  );
}
it("pure R and structure-confirmed breakeven remain distinct at exact threshold", () => {
  const bars = input([100, 100, 101.5, 100, 100, 100]);
  const early = run("rk-be03", bars).trades[0]!;
  expect(early.exitDate).toBe(bars[4]!.date);
  expect(run("rk-be05", bars).trades[0]!.exitDate).toBeNull();
  expect(run("rk-be-none", bars).trades[0]!.exitDate).toBeNull();
  const oneR = input([100, 100, 105, 100, 100, 100]);
  expect(run("rk-be1", oneR).trades[0]!.exitDate).toBe(oneR[4]!.date);
  expect(run("rk-be1-structure", oneR).trades[0]!.exitDate).toBeNull();
});
it("10-day progress exits without replacing the protective price stop", () => {
  const flat = input(Array(16).fill(100));
  const result = run("rk-time10", flat).trades[0]!;
  expect(result.exitDate).toBe(flat[11]!.date);
  expect(result.exitReason).toContain("10");
  const loss = input([100, 100, 94, 100, 100]);
  expect(run("rk-time10", loss).trades[0]!.exitDate).toBe(loss[3]!.date);
  const equal = input([100, 100, ...Array(14).fill(102.5)]);
  expect(run("rk-time10", equal).trades[0]!.exitDate).toBeNull();
});

it("the portfolio recomputes aggregate risk after each same-open fill without today's close", () => {
  const bars = input([100, 200]);
  const events: ResearchEvent[] = Array.from({ length: 6 }, (_, i) => ({
    symbol: `sh60000${i}`,
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: `risk${i}`,
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
  }));
  const series = new Map(events.map((e) => [e.symbol, bars]));
  const spec = {
    ...applyResearchManagement(base, riskPresetTemplate("rk-total4")),
    maxPositions: 10,
  };
  const result = researchPortfolio(
    spec,
    events,
    bars.map((b) => b.date),
    series,
    () => rules,
  );
  expect(result.trades).toHaveLength(4);
  expect(result.trades.map((t) => t.quantity)).toEqual([200, 200, 200, 200]);
  expect(
    result.attempts.some((a) => a.reason.includes("组合在险预算不足")),
  ).toBe(true);
});
