import { researchKellyTraining } from "../src/lib/research-kelly-training";
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

it("five-day time discipline and direct budget reduction change actual fills", () => {
  const flat = input(Array(12).fill(100));
  expect(run("sw-time5", flat).trades[0]!.exitDate).toBe(flat[6]!.date);
  expect(run("rk-reduce-half", flat).trades[0]!.quantity).toBe(100);
  expect(run("rk-equity-current", flat).trades[0]!.quantity).toBe(200);
  expect(run("rk-admit-example50", flat).trades[0]!.quantity).toBe(100);
  expect(run("rk-admit-example40", flat).trades[0]!.quantity).toBe(200);
  expect(run("rk-admit-quality3", flat).trades).toHaveLength(0);
  expect(run("rk-admit-rr2", flat).excluded[0]!.reason).toContain("目标");
});
it("account close loss prevents the next opening buy, while a control fills it", () => {
  const bars = input([100, 100, 90, 90, 100, 100]);
  bars[3]!.open = 90;
  const events: ResearchEvent[] = [0, 2].map((i) => ({
    symbol: i === 0 ? "sh600000" : "sh600001",
    observedDate: bars[i]!.date,
    endpointDate: bars[i]!.date,
    key: String(i),
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
  }));
  const series = new Map([
    ["sh600000", bars],
    ["sh600001", input(Array(6).fill(100))],
  ]);
  const simulate = (id: (typeof riskPresetIds)[number]) =>
    researchPortfolio(
      applyResearchManagement(base, riskPresetTemplate(id)),
      events,
      bars.map((b) => b.date),
      series,
      () => rules,
    );
  const controlled = simulate("rk-account-day2"),
    baseline = simulate("rk-equity-current");
  expect(baseline.trades[1]!.entryDate).toBe(bars[3]!.date);
  expect(controlled.trades[1]!.entryDate).toBe(bars[4]!.date);
  expect(controlled.attempts.some((a) => a.reason.includes("账户风控"))).toBe(
    true,
  );
});

it("half Kelly, risk sizing and 30-percent total exposure constrain actual simultaneous fills", () => {
  const bars = input([100, 100, 100]);
  const training = researchKellyTraining(
    Array.from({ length: 30 }, (_, i) => ({
      event: {
        symbol: "sh600000",
        key: String(i),
        observedDate: "2020-01-01",
        partition: "development",
      },
      entryDate: "2020-01-02",
      exitDate: "2020-01-03",
      profit: i < 15 ? 2 : -1,
      remainingQuantity: 0,
    })),
    "2020-01-01",
    "2020-02-01",
  );
  const events: ResearchEvent[] = Array.from({ length: 4 }, (_, i) => ({
    symbol: `sh60000${i}`,
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: String(i),
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "validation",
  }));
  const result = researchPortfolio(
    {
      ...applyResearchManagement(base, riskPresetTemplate("rk-admit-kelly30")),
      maxPositions: 10,
    },
    events,
    bars.map((b) => b.date),
    new Map(events.map((e) => [e.symbol, bars])),
    () => rules,
    undefined,
    training,
  );
  expect(result.trades.map((t) => t.quantity)).toEqual([100, 100, 100]);
  expect(result.riskAdmissionChecks![0]!.sizing).toEqual({
    riskQuantity: 400,
    kellyQuantity: 100,
    singleStockQuantity: 300,
    finalQuantity: 100,
    binding: ["分数凯利"],
  });
  expect(result.nav[1]!.cash).toBe(70000);
});

it("RR2 accepts equality at the real opening and rejects a gap that destroys the frozen ratio", () => {
  const bars = input([100, 100, 100]);
  const e: ResearchEvent = {
    symbol: "sh600000",
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: "rr2",
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
    entryTarget: 110,
  };
  const simulate = () =>
    researchPortfolio(
      applyResearchManagement(base, riskPresetTemplate("rk-admit-rr2")),
      [e],
      bars.map((b) => b.date),
      new Map([[e.symbol, bars]]),
      () => rules,
    );
  expect(simulate().trades).toHaveLength(1);
  bars[1]!.open = 101;
  bars[1]!.high = 102;
  expect(simulate().trades).toHaveLength(0);
});
