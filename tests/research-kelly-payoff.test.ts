import { expect, it } from "vitest";
import { researchKellyTraining } from "../src/lib/research-kelly-training";
import { researchKellyNetPayoff } from "../src/lib/research-kelly-payoff";
import {
  researchKellyLimit,
  researchKellySchema,
} from "../src/lib/research-kelly";

function train(profits: number[]) {
  return researchKellyTraining(
    profits.map((profit, i) => ({
      event: {
        symbol: "sh600000",
        key: String(i),
        observedDate: "2024-01-01",
        partition: "development",
      },
      entryDate: "2024-01-02",
      exitDate: "2024-01-03",
      profit,
    })),
    "2024-01-01",
    "2024-02-01",
  );
}
const config = { provenance: "development-net-payoff" as const, fraction: 0.5 };
it("uses net monetary means and excludes zeros only from payoff means", () => {
  const sample = train([
    ...Array(15).fill(100),
    ...Array(10).fill(-50),
    ...Array(5).fill(0),
  ]);
  const payoff = researchKellyNetPayoff(sample);
  expect(sample.winRate).toBe(0.5);
  expect(payoff.meanWinNetProfit).toBeCloseTo(100, 12);
  expect(payoff.payoff).toBeCloseTo(2, 14);
  expect(payoff).toMatchObject({
    wins: 15,
    losses: 10,
    meanLossAbsNetProfit: 50,
    reason: null,
  });
  expect(
    researchKellyLimit(config, sample.winRate, payoff.payoff).weight,
  ).toBeCloseTo(0.125);
});
it("rejects short or one-sided samples without assuming a payoff", () => {
  for (const profits of [
    Array(29).fill(1),
    Array(30).fill(1),
    Array(30).fill(-1),
    Array(30).fill(0),
  ]) {
    const payoff = researchKellyNetPayoff(train(profits));
    expect(payoff.payoff).toBeNull();
    expect(payoff.reason).not.toBeNull();
    expect(researchKellyLimit(config, 0.5, payoff.payoff).weight).toBeNull();
  }
  expect(researchKellyNetPayoff(null).payoff).toBeNull();
});
it("preserves unavailable overflow and rejects manual overrides", () => {
  expect(
    researchKellyNetPayoff(
      train([...Array(15).fill(1e308), ...Array(15).fill(-1e-308)]),
    ).payoff,
  ).toBeNull();
  expect(researchKellySchema.safeParse({ ...config, payoff: 2 }).success).toBe(
    false,
  );
  expect(
    researchKellySchema.safeParse({ ...config, winRate: 0.5 }).success,
  ).toBe(false);
  expect(researchKellyLimit(config, 0.5, Infinity).weight).toBeNull();
});
