import { expect, it } from "vitest";
import {
  researchRiskAdmission,
  riskAdmissionNeedsTraining,
  type RiskAdmissionRule,
} from "trading-strategies/research/risk/research-risk-admission";
import { researchKellyTraining } from "trading-strategies/research/risk/research-kelly-training";
const train = (profits: number[]) =>
  researchKellyTraining(
    profits.map((profit, i) => ({
      event: {
        symbol: "sh600000",
        key: String(i),
        observedDate: "2020-01-01",
        partition: "development",
      },
      entryDate: "2020-01-02",
      exitDate: "2020-01-03",
      profit,
      remainingQuantity: 0,
    })),
    "2020-01-01",
    "2020-02-01",
  );
const run = (rule: RiskAdmissionRule, profits: number[]) =>
  researchRiskAdmission(rule, "2021-01-01", "{}", train(profits));
it.each([
  ["example50", 0.5, 2, 0.5, 0.5],
  ["example40", 0.4, 3, 0.6, 1],
  ["example60", 0.6, 1, 0.2, 0.5],
] as const)(
  "%s freezes assumptions separately from empirical inputs",
  (rule, p, b, e, scale) => {
    const result = researchRiskAdmission(rule, "2021-01-01", "{}");
    expect(result.assumptionWinRate).toBe(p);
    expect(result.assumptionPayoff).toBe(b);
    expect(result.expectancy).toBeCloseTo(e);
    expect(result.scale).toBe(scale);
    expect(result.allow).toBe(true);
    expect(riskAdmissionNeedsTraining(rule)).toBe(false);
  },
);
it("45% includes the exact threshold and all winning samples do not require a loss estimate", () => {
  expect(
    run(
      "win45",
      Array.from({ length: 40 }, (_, i) => (i < 18 ? 2 : -1)),
    ).allow,
  ).toBe(true);
  expect(
    run(
      "win45",
      Array.from({ length: 40 }, (_, i) => (i < 17 ? 2 : -1)),
    ).allow,
  ).toBe(false);
  expect(run("win45", Array(30).fill(1)).allow).toBe(true);
});
it("nonpositive expectation and all-loss training remain visible without invented payoff", () => {
  const zero = Array.from({ length: 30 }, (_, i) => (i < 15 ? 1 : -1));
  expect(run("positive", zero)).toMatchObject({ allow: false, expectancy: 0 });
  const loss = run("positive", Array(30).fill(-1));
  expect(loss).toMatchObject({ allow: false, p: 0, b: 0, expectancy: -1 });
  expect(loss.samples).toHaveLength(30);
  expect(run("kelly30", Array(30).fill(1))).toMatchObject({
    allow: false,
    b: null,
    fullKelly: null,
  });
});
it("expectation sizing keeps 0.2/0.5 inclusive and scales both budgets", () => {
  const make = (b: number) =>
    Array.from({ length: 30 }, (_, i) => (i < 15 ? b : -1));
  expect(run("expect-size", make(1.399))).toMatchObject({
    allow: false,
    scale: 0,
  });
  expect(run("expect-size", make(1.4))).toMatchObject({
    allow: true,
    scale: 0.5,
  });
  expect(run("expect-size", make(2))).toMatchObject({
    allow: true,
    scale: 0.5,
  });
  expect(run("expect-size", make(2.01))).toMatchObject({
    allow: true,
    scale: 1,
  });
  expect(run("expect02", make(1.4)).allow).toBe(true);
  expect(run("expect02", make(1.399)).allow).toBe(false);
});
it("half and quarter Kelly use only development samples and retain zero outcomes", () => {
  const ps = Array.from({ length: 40 }, (_, i) =>
    i < 20 ? 2 : i < 35 ? -1 : 0,
  );
  expect(run("kelly30", ps)).toMatchObject({
    p: 0.5,
    b: 2,
    fullKelly: 0.25,
    maxWeight: 0.125,
    allow: true,
  });
  expect(run("quarter-kelly", ps).maxWeight).toBe(0.0625);
  const t = train(ps);
  t.cutoff = "2022-01-01";
  expect(researchRiskAdmission("kelly30", "2021-01-01", "{}", t).allow).toBe(
    false,
  );
  t.cutoff = "2020-02-01";
  t.samples[0]!.exitDate = t.cutoff;
  expect(researchRiskAdmission("kelly30", "2021-01-01", "{}", t).allow).toBe(
    false,
  );
  expect(run("kelly30", ps.slice(0, 29)).allow).toBe(false);
});
it("quality admission requires three of five explicit checks and never trusts a supplied score", () => {
  const evidence = (count: number) =>
    JSON.stringify({
      score: 5,
      checks: Object.fromEntries(
        ["trend", "level", "volume", "indicators", "candle"].map((k, i) => [
          k,
          i < count ? "是" : "否",
        ]),
      ),
    });
  expect(
    researchRiskAdmission("quality3", "2021-01-01", evidence(3)),
  ).toMatchObject({ allow: true, score: 3, p: null });
  expect(
    researchRiskAdmission("quality3", "2021-01-01", evidence(2)).allow,
  ).toBe(false);
  expect(
    researchRiskAdmission("quality3", "2021-01-01", '{"score":5}').allow,
  ).toBe(false);
});
