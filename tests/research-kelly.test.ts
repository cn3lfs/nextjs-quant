import { expect, it } from "vitest";
import {
  researchKellyLimit,
  researchKellySchema,
} from "../src/lib/research-kelly";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { researchKellyQuality } from "../src/lib/research-kelly-quality";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";
const assumption = {
  winRate: 0.5,
  payoff: 2,
  fraction: 0.5,
  provenance: "manual-scenario" as const,
};
const dates = Array.from({ length: 8 }, (_, i) => `2024-01-0${i + 1}`);
const bars = () =>
  dates.map((date) => ({
    date,
    open: 10,
    close: 10,
    high: 11,
    low: 9,
    volume: 10000,
    amount: 1000000,
  }));
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[7],
  validationStart: dates[7],
  holdingDays: 60,
  initialCapital: 100000,
  risk: { fraction: 0.1, maxWeight: 1 },
  management: { stop: { kind: "percent", fraction: 0.1 }, kelly: assumption },
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
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
const run = (config = spec, input = bars()) =>
  researchPortfolio(
    config,
    [event],
    dates,
    new Map([[event.symbol, input]]),
    () => rules,
  );
const qualityEvidence = (score: number) =>
  JSON.stringify({
    score: 5,
    checks: Object.fromEntries(
      ["trend", "level", "volume", "indicators", "candle"].map((key, index) => [
        key,
        index < score ? "是" : "否",
      ]),
    ),
  });
it.each([
  [3, 800],
  [4, 1200],
  [5, 1600],
])("sizes quality %s from checks, not a supplied score", (score, quantity) => {
  const config = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      kelly: { provenance: "breakout-quality", payoff: 2, fraction: 0.5 },
    },
  });
  const result = researchPortfolio(
    config,
    [{ ...event, evidence: qualityEvidence(score!) }],
    dates,
    new Map([[event.symbol, bars()]]),
    () => rules,
  );
  expect(result.kellyChecks![0]!.filledQuantity).toBe(quantity);
  expect(result.kellyChecks![0]!.quality!.score).toBe(score);
  expect(result.kellyChecks![0]!.signalDate).toBe(event.observedDate);
  expect(result.kelly!.perSignal).toBe(true);
  const switched = selectResearchStrategy(config, "ma-cross");
  expect(switched.management).not.toHaveProperty("kelly");
  expect(researchSpecSchema.safeParse(switched).success).toBe(true);
});
it("rejects unavailable and low quality without trusting asserted probability", () => {
  for (const evidence of [
    "{}",
    "null",
    "broken",
    qualityEvidence(2),
    JSON.stringify({ score: 5, winRate: 0.99, checks: { trend: "未知" } }),
  ]) {
    expect(researchKellyQuality(evidence).winRate).toBeNull();
    const config = researchSpecSchema.parse({
      ...spec,
      management: {
        ...spec.management,
        kelly: { provenance: "breakout-quality", payoff: 2, fraction: 0.5 },
      },
    });
    expect(
      researchPortfolio(
        config,
        [{ ...event, evidence }],
        dates,
        new Map([[event.symbol, bars()]]),
        () => rules,
      ).trades,
    ).toEqual([]);
  }
});
it("computes fractional assumptions without accepting invalid or overflowing inputs", () => {
  expect(researchKellyLimit(assumption)).toEqual({
    fullKelly: 0.25,
    weight: 0.125,
    reason: null,
  });
  expect(
    researchKellyLimit({ ...assumption, winRate: 0.2, payoff: 1 }).weight,
  ).toBe(0);
  for (const winRate of [0, 1, NaN, Infinity])
    expect(
      researchKellySchema.safeParse({ ...assumption, winRate }).success,
    ).toBe(false);
  expect(
    researchKellySchema.safeParse({ ...assumption, fraction: 1.01 }).success,
  ).toBe(false);
  expect(
    researchKellyLimit({ ...assumption, payoff: Number.MIN_VALUE }).weight,
  ).toBeNull();
  expect(
    researchKellyLimit({ ...assumption, payoff: Number.MAX_VALUE }).weight,
  ).toBeCloseTo(0.25);
});
it.each([
  [0.25, 600],
  [0.5, 1200],
  [1, 2500],
])("caps total initial value using fraction %s", (fraction, quantity) => {
  const config = researchSpecSchema.parse({
    ...spec,
    management: { ...spec.management, kelly: { ...assumption, fraction } },
  });
  const result = run(config);
  expect(result.trades[0]!.quantity).toBe(quantity);
  expect(result.kellyChecks![0]).toMatchObject({
    phase: "entry",
    equity: 100000,
    riskBudget: 10000,
    filledQuantity: quantity,
    heldQuantity: 0,
  });
  expect(result.kelly!.provenance).toBe("manual-scenario");
});
it("keeps tighter risk, single-stock and fee constraints", () => {
  expect(
    run({ ...spec, risk: { fraction: 0.005, maxWeight: 1 } }).trades[0]!
      .quantity,
  ).toBe(500);
  expect(
    run({ ...spec, risk: { fraction: 0.1, maxWeight: 0.03 } }).trades[0]!
      .quantity,
  ).toBe(300);
  const input = bars().map((b) => ({
    ...b,
    open: 12.5,
    close: 12.5,
    high: 13,
    low: 12,
  }));
  const config = researchSpecSchema.parse({
    ...spec,
    costs: { ...spec.costs, minimumCommission: 5 },
  });
  expect(run(config, input).trades[0]!.quantity).toBe(900);
});
it("blocks nonpositive Kelly while existing stop execution remains active", () => {
  const blocked = run(
    researchSpecSchema.parse({
      ...spec,
      management: {
        ...spec.management,
        kelly: { ...assumption, winRate: 0.2, payoff: 1 },
      },
    }),
  );
  expect(blocked.trades).toEqual([]);
  expect(blocked.attempts.some((a) => a.reason.includes("凯利非正"))).toBe(
    true,
  );
  const input = bars();
  input[2]!.close = 8;
  input[2]!.low = 7;
  input[3]!.open = 7;
  input[3]!.low = 6;
  const trade = run(spec, input).trades[0]!;
  expect(trade.exitDate).toBe(dates[3]);
  expect(trade.exitPrice).toBe(7);
});
it("applies the cap to existing plus added shares and preserves disabled snapshots", () => {
  const input = bars();
  for (let i = 2; i < input.length; i++)
    Object.assign(input[i]!, {
      open: i === 2 ? 10 : i === 3 ? 12 : 14,
      close: i === 2 ? 12 : 14,
      high: 15,
      low: 9,
    });
  const config = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      pyramid: { kind: "r-50-30-20", maxTotalWeight: 1 },
    },
  });
  const result = run(config, input);
  const qualityConfig = researchSpecSchema.parse({
    ...config,
    management: {
      ...config.management,
      kelly: { provenance: "breakout-quality", payoff: 2, fraction: 0.5 },
    },
  });
  const qualityResult = researchPortfolio(
    qualityConfig,
    [{ ...event, evidence: qualityEvidence(4) }],
    dates,
    new Map([[event.symbol, input]]),
    () => rules,
  );
  expect(
    qualityResult.kellyChecks!.some(
      (row) => row.phase === "add" && row.filledQuantity > 0,
    ),
  ).toBe(true);
  for (const row of qualityResult.kellyChecks!) {
    expect(row.quality).toMatchObject({ score: 4, winRate: 0.5, reason: null });
    expect(row.signalDate).toBe(event.observedDate);
    if (row.filledQuantity > 0)
      expect(
        (row.heldQuantity + row.filledQuantity) * row.price,
      ).toBeLessThanOrEqual(row.kellyValue! + 1e-8);
  }
  expect(
    result.kellyChecks!.some((r) => r.phase === "add" && r.filledQuantity > 0),
  ).toBe(true);
  for (const row of result.kellyChecks!)
    if (row.filledQuantity > 0)
      expect(
        (row.heldQuantity + row.filledQuantity) * row.price,
      ).toBeLessThanOrEqual(row.kellyValue! + 1e-8);
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "kelly.version",
    "research-kelly-1",
  );
  const { kelly: _kelly, ...management } = spec.management!;
  const legacy = { ...spec, management };
  expect(run(legacy)).not.toHaveProperty("kelly");
  expect(run(legacy)).not.toHaveProperty("kellyChecks");
  expect(researchMethodSnapshot(legacy)).not.toHaveProperty("kelly");
});
