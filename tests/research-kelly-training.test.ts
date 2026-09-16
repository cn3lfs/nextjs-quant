import { expect, it } from "vitest";
import { researchKellyTraining } from "../src/lib/research-kelly-training";
import { researchKellyLimit } from "../src/lib/research-kelly";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { maParamsSchema } from "../src/lib/domain";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";
import { researchMethodSnapshot } from "../src/server/research-method";
const sample = (i: number, profit = 1) => ({
  event: {
    symbol: "sh600000",
    key: String(i),
    observedDate: "2024-01-01",
    partition: "development",
  },
  entryDate: "2024-01-02",
  exitDate: "2024-01-03" as string | null,
  profit: profit as number | null,
  remainingQuantity: 0,
});
it("requires thirty unique fully closed net outcomes and keeps zero outcomes explicit", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    sample(i, i < 15 ? 1 : i < 25 ? -1 : 0),
  );
  expect(
    researchKellyTraining(rows.slice(1), "2024-01-01", "2024-02-01").winRate,
  ).toBeNull();
  const result = researchKellyTraining(rows, "2024-01-01", "2024-02-01");
  expect(result).toMatchObject({
    wins: 15,
    losses: 10,
    zeros: 5,
    winRate: 0.5,
    reason: null,
  });
  expect(
    researchKellyTraining([...rows, rows[0]!], "2024-01-01", "2024-02-01")
      .winRate,
  ).toBeNull();
  const invalid = [
    { ...sample(31), exitDate: null },
    { ...sample(32), exitDate: "2024-02-01" },
    { ...sample(33), remainingQuantity: 100 },
    { ...sample(34), profit: NaN },
    { ...sample(35), event: { ...sample(35).event, partition: "validation" } },
  ];
  expect(
    researchKellyTraining([...rows, ...invalid], "2024-01-01", "2024-02-01"),
  ).toMatchObject({ wins: 15, excluded: 5, winRate: 0.5 });
  const config = {
    provenance: "development-closed" as const,
    payoff: 2,
    fraction: 0.5,
  };
  expect(researchKellyLimit(config).weight).toBeNull();
  expect(researchKellyLimit(config, 0).weight).toBe(0);
  expect(researchKellyLimit(config, 1).weight).toBe(0.5);
});
function fixture(validationIndex = 125) {
  const bars = Array.from({ length: 145 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 10 + i,
    close: 10 + i,
    high: 12 + i,
    low: 8 + i,
    volume: 10000,
    amount: (10 + i) * 10000,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "ma-cross",
    maParams: maParamsSchema.parse({}),
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[135]!.date,
    validationStart: bars[validationIndex]!.date,
    holdingDays: 1,
    initialCapital: 1000000,
    maxPositions: 1,
    risk: { fraction: 0.1, maxWeight: 0.8 },
    management: {
      kelly: { provenance: "development-closed", payoff: 2, fraction: 0.5 },
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic-fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
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
        hash: researchHash(bars),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixed-input",
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
        start: spec.start,
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
      evidenceId: "fixture",
    })),
  });
  return { spec, dataset, evidence, bars };
}
const native = async (): Promise<never> => {
  throw Error("unexpected native");
};
it("freezes monetary payoff from development without using validation prices", async () => {
  const { spec, dataset, evidence } = fixture();
  spec.management!.kelly = {
    provenance: "development-net-payoff",
    fraction: 0.5,
  };
  dataset.method = researchMethodSnapshot(spec);
  dataset.stocks[0]!.bars = dataset.stocks[0]!.bars.map((bar, i) => {
    const open = bar.close * (i % 4 < 2 ? 0.98 : 1.02);
    return {
      ...bar,
      open,
      high: Math.max(open, bar.close) + 2,
      low: Math.min(open, bar.close) - 2,
    };
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const training = result.kellyTraining!;
  expect(training.samples.length).toBeGreaterThanOrEqual(30);
  const wins = training.samples.filter((s) => s.profit > 0);
  const losses = training.samples.filter((s) => s.profit < 0);
  expect(wins.length).toBeGreaterThan(0);
  expect(losses.length).toBeGreaterThan(0);
  const b =
    wins.reduce((n, s) => n + s.profit, 0) /
    wins.length /
    (-losses.reduce((n, s) => n + s.profit, 0) / losses.length);
  expect(training.netPayoff!.payoff).toBeCloseTo(b, 12);
  const p = wins.length / training.samples.length;
  expect(result.partitions[1]!.simulation!.kelly!.weight).toBeCloseTo(
    Math.max(0, p - (1 - p) / b) * 0.5,
    12,
  );
  const changed = structuredClone(dataset);
  changed.stocks[0]!.bars = changed.stocks[0]!.bars.map((bar) =>
    bar.date >= spec.validationStart
      ? {
          ...bar,
          open: bar.open / 2,
          close: bar.close / 2,
          high: bar.high / 2,
          low: bar.low / 2,
        }
      : bar,
  );
  changed.hash = researchHash(changed.stocks[0]!.bars);
  const rerun = await runStrategyResearch(spec, changed, evidence, native);
  expect(rerun.kellyTraining!.samples).toEqual(training.samples);
  expect(rerun.kellyTraining!.netPayoff).toEqual(training.netPayoff);
});
it("keeps net payoff warnings outside partitions and refuses an all-win reference", async () => {
  const { spec, dataset, evidence } = fixture();
  spec.management!.kelly = {
    provenance: "development-net-payoff",
    fraction: 0.5,
  };
  dataset.method = researchMethodSnapshot(spec);
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.kellyTraining!.samples.length).toBeGreaterThanOrEqual(30);
  expect(result.kellyTraining!.netPayoff!.payoff).toBeNull();
  expect(result.kellyTraining!.netPayoff!.reason).toContain("缺少盈利或亏损");
  expect(result.partitions[1]!.simulation!.trades).toEqual([]);
  expect(result.partitions[1]!.simulation!.kelly!.weight).toBeNull();
  expect(result.warnings.some((text) => text.includes("净损益金额均值"))).toBe(
    true,
  );
  for (const partition of result.partitions)
    expect(partition).not.toHaveProperty("0");
});
it("trains on the development reference then freezes validation sizing without future outcomes", async () => {
  const { spec, dataset, evidence } = fixture();
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.kellyTraining!.samples.length).toBeGreaterThanOrEqual(30);
  expect(result.kellyTraining!.winRate).toBe(1);
  expect(result.partitions[0]!.kellyRole).toBe("reference-without-kelly");
  expect(result.partitions[0]!.simulation).not.toHaveProperty("kelly");
  expect(result.partitions[1]!.simulation!.kelly!.weight).toBe(0.5);
  expect(result.partitions[1]!.simulation!.trades.length).toBeGreaterThan(0);
  expect(
    result.kellyTraining!.samples.every(
      (t) => t.exitDate < spec.validationStart,
    ),
  ).toBe(true);
  const changed = dataset.stocks[0]!.bars.map((b) =>
    b.date >= spec.validationStart
      ? {
          ...b,
          open: b.open * 0.5,
          close: b.close * 0.5,
          high: b.high * 0.5,
          low: b.low * 0.5,
        }
      : b,
  );
  const rerun = await runStrategyResearch(
    spec,
    {
      ...dataset,
      hash: researchHash(changed),
      stocks: [
        { ...dataset.stocks[0]!, bars: changed, hash: researchHash(changed) },
      ],
    },
    evidence,
    native,
  );
  expect(rerun.kellyTraining!.samples).toEqual(result.kellyTraining!.samples);
  expect(rerun.kellyTraining!.winRate).toBe(result.kellyTraining!.winRate);
  expect(rerun.kellyTraining!.reference.specHash).toBe(
    result.kellyTraining!.reference.specHash,
  );
  expect(rerun.kellyTraining!.hash).not.toBe(result.kellyTraining!.hash);
  expect(rerun.partitions[1]!.simulation!.kelly!.weight).toBe(0.5);
  expect(await runStrategyResearch(spec, dataset, evidence, native)).toEqual(
    result,
  );
});
it("does not bootstrap validation from manual guesses when the reference sample is short", async () => {
  const { spec, dataset, evidence } = fixture(90);
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.kellyTraining!.winRate).toBeNull();
  expect(result.kellyTraining!.reason).toContain("不足30");
  expect(result.partitions[0]!.simulation!.trades.length).toBeGreaterThan(0);
  expect(result.partitions[1]!.simulation!.trades).toEqual([]);
  expect(
    result.partitions[1]!.simulation!.attempts.some((a) =>
      a.reason.includes("胜率不可用"),
    ),
  ).toBe(true);
  const missing = await runStrategyResearch(spec, dataset, null, native);
  expect(missing.kellyTraining!.winRate).toBeNull();
  expect(missing.partitions.every((p) => p.simulation === null)).toBe(true);
});
