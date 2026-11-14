import { expect, it } from "vitest";
import {
  researchKellyLimit,
  researchKellySchema,
} from "trading-strategies/research/risk/research-kelly";
import { researchSpecSchema } from "../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../src/server/research/research-method";
import { researchKellyQuality } from "trading-strategies/research/risk/research-kelly-quality";
const assumption = {
  winRate: 0.5,
  payoff: 2,
  fraction: 0.5,
  provenance: "manual-scenario" as const,
};
const dates = Array.from({ length: 8 }, (_, i) => `2024-01-0${i + 1}`);
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
it("rejects unavailable and low quality without trusting asserted probability", () => {
  for (const evidence of [
    "{}",
    "null",
    "broken",
    qualityEvidence(2),
    JSON.stringify({ score: 5, winRate: 0.99, checks: { trend: "未知" } }),
  ]) {
    expect(researchKellyQuality(evidence).winRate).toBeNull();
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
it("records the Kelly rule version only when configured", () => {
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "kelly.version",
    "research-kelly-1",
  );
  const { kelly: _kelly, ...management } = spec.management!;
  const legacy = { ...spec, management };
  expect(researchMethodSnapshot(legacy)).not.toHaveProperty("kelly");
});
