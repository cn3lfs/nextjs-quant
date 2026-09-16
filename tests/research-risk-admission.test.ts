import { expect, it, vi } from "vitest";
import {
  researchRiskAdmission,
  riskAdmissionNeedsTraining,
  type RiskAdmissionRule,
} from "../src/lib/research-risk-admission";
import { researchKellyTraining } from "../src/lib/research-kelly-training";
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

import * as signals from "../src/server/research-signals";
import { runStrategyResearch } from "../src/server/research-run";
import { researchMethodSnapshot } from "../src/server/research-method";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { riskPresetTemplate } from "../src/lib/research-risk-presets";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import type { ResearchDataset } from "../src/server/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
it("run entrypoint trains a real reference ledger without admission and never learns from validation prices", async () => {
  const bars = Array.from({ length: 106 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: i % 3 === 0 ? 90 : 100,
    close: i % 3 === 2 ? 90 : 100,
    high: 101,
    low: 89,
    volume: 100000,
    amount: 10000000,
  }));
  const spec = researchSpecSchema.parse(
    applyResearchManagement(
      researchSpecSchema.parse({
        strategy: "dual-breakout",
        start: bars[0]!.date,
        end: bars[105]!.date,
        validationStart: bars[96]!.date,
        initialCapital: 100000,
        costs: {
          commissionBps: 0,
          minimumCommission: 0,
          sellTaxBps: 0,
          slippageBps: 0,
        },
      }),
      riskPresetTemplate("rk-admit-positive"),
    ),
  );
  const events: ResearchEvent[] = bars.flatMap((b, i) =>
    i % 3
      ? []
      : [
          {
            symbol: "sh600000",
            observedDate: b.date,
            endpointDate: b.date,
            key: String(i),
            strategyVersion: "synthetic-confirmed",
            evidence: "{}",
            partition: i < 96 ? "development" : "validation",
          },
        ],
  );
  const mock = vi.spyOn(signals, "researchSignals").mockResolvedValue(events);
  try {
    const dataset: ResearchDataset = {
      version: "research-dataset-1",
      source: "tdx-local",
      root: "fixture",
      adjustment: "none",
      membership: {
        mode: "current-snapshot",
        symbols: ["sh600000"],
        source: null,
        warning: "fixture",
      },
      benchmark: { symbol: "sh000001", bars },
      calendar: bars.map((b) => b.date),
      stocks: [
        {
          symbol: "sh600000",
          name: "fixture",
          bars,
          hash: "fixture",
          actions: [],
        },
      ],
      excluded: [],
      actionCoverage: "partial",
      actionSource: { path: "fixture", modified: 0 },
      capturedAt: 0,
      hash: "fixture",
      method: researchMethodSnapshot(spec),
    };
    const evidence = researchMarketEvidenceSchema.parse({
      version: "research-market-evidence-1",
      source: "fixture",
      exportedAt: 0,
      adjustment: "none",
      corporateActionFree: [
        {
          symbol: "sh600000",
          start: bars[0]!.date,
          end: spec.end,
          evidenceId: "fixture",
        },
      ],
      rows: bars.map((b) => ({
        symbol: "sh600000",
        date: b.date,
        tradable: true,
        limitUp: null,
        limitDown: null,
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        minimumSell: 100,
        sellStep: 100,
        maximumSell: 100000,
        sellOddLotAll: true,
        evidenceId: "fixture",
      })),
    });
    const native = async (): Promise<never> => {
      throw Error("unexpected native");
    };
    const result = await runStrategyResearch(spec, dataset, evidence, native);
    expect(result.kellyTraining!.samples.length).toBeGreaterThanOrEqual(30);
    expect(
      result.kellyTraining!.samples.every(
        (t) => t.profit < 0 && t.exitDate < spec.validationStart,
      ),
    ).toBe(true);
    expect(result.partitions[0]!.simulation!.trades.length).toBeGreaterThan(30);
    expect(result.partitions[1]!.simulation!.trades).toHaveLength(0);
    expect(
      result.partitions[1]!.simulation!.riskAdmissionChecks![0]!.check,
    ).toMatchObject({ allow: false, p: 0, b: 0, expectancy: -1 });
    const changed = structuredClone(dataset);
    changed.stocks[0]!.bars = bars.map((b) =>
      b.date < spec.validationStart
        ? b
        : { ...b, open: 1000, high: 1100, low: 900, close: 1000 },
    );
    const rerun = await runStrategyResearch(spec, changed, evidence, native);
    expect(rerun.kellyTraining!.samples).toEqual(result.kellyTraining!.samples);
    expect(rerun.partitions[1]!.simulation!.riskAdmissionChecks).toEqual(
      result.partitions[1]!.simulation!.riskAdmissionChecks,
    );
  } finally {
    mock.mockRestore();
  }
});

it("RR2 freezes the real breakout target on the signal event", async () => {
  const bars = Array.from({ length: 145 }, (_, i) => {
    const high =
      160 - 0.1 * i - 5 * (1 - Math.cos((2 * Math.PI * (i - 85)) / 25));
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: high - 2,
      close: high - 1,
      high,
      low: high - 3,
      volume: 10000,
      amount: 1000000,
    };
  });
  Object.assign(bars[140]!, {
    open: 140,
    close: 151,
    high: 152,
    low: 139,
    volume: 30000,
  });
  const spec = researchSpecSchema.parse(
    applyResearchManagement(
      researchSpecSchema.parse({
        strategy: "dual-breakout",
        start: bars[140]!.date,
        end: bars[144]!.date,
        validationStart: bars[143]!.date,
      }),
      riskPresetTemplate("rk-admit-rr2"),
    ),
  );
  const events = await signals.researchSignals(
    "sh600000",
    bars,
    spec,
    async (): Promise<never> => {
      throw Error("unexpected native");
    },
  );
  expect(events.length).toBeGreaterThan(0);
  expect(events[0]!.entryTarget).toBe(
    JSON.parse(events[0]!.evidence).risk.target1?.price ?? null,
  );
});
