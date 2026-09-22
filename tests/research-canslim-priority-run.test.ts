import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

const bars = (): Bar[] =>
  Array.from({ length: 70 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 97,
    high: i === 69 ? 103 : 100,
    low: 95,
    close: i === 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
it("runs a registered signal with executable price bounds and prior action coverage", async () => {
  const input = bars();
  for (let i = 70; i < 77; i++)
    input.push({
      ...input[69]!,
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: 102,
      close: 102,
      high: 103,
      low: 101,
    });
  const spec = researchSpecSchema.parse({
    strategy: "canslim-priority",
    symbols: ["sh600000"],
    start: input[61]!.date,
    end: input[76]!.date,
    validationStart: input[75]!.date,
    holdingDays: 2,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const native = async (): Promise<never> => {
    throw Error("unexpected native");
  };
  const events = await researchSignals("sh600000", input, spec, native);
  expect(events).toHaveLength(1);
  expect(events[0]!.observedDate).toBe(input[69]!.date);
  expect(events[0]!.entryPriceRange).toEqual({ min: 100, max: 105 });
  const rules = {
    evidence: "fixture",
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
  };
  const run = (series = input, slippageBps = 0) =>
    researchPortfolio(
      { ...spec, costs: { ...spec.costs, slippageBps } },
      events,
      input.map((b) => b.date),
      new Map([["sh600000", series]]),
      () => rules,
    );
  expect(run().trades[0]).toMatchObject({
    entryDate: input[70]!.date,
    entryPrice: 102,
    exitDate: input[72]!.date,
  });
  for (const open of [99, 106]) {
    const changed = structuredClone(input);
    Object.assign(changed[70]!, {
      open,
      high: Math.max(open, 103),
      low: Math.min(open, 101),
    });
    expect(run(changed).trades).toEqual([]);
    expect(
      run(changed).excluded.some((row) => row.reason.includes("区间")),
    ).toBe(true);
  }
  const edge = structuredClone(input);
  Object.assign(edge[70]!, { open: 105, high: 106 });
  expect(run(edge).trades.length).toBe(1);
  expect(run(edge, 10).trades).toEqual([]);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars: input },
    calendar: input.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars: input,
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
        start: input[0]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: input.map((b) => ({
      symbol: "sh600000",
      date: b.date,
      ...rules,
      evidenceId: "fixture",
    })),
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.partitions[0]!.simulation!.trades.length).toBe(1);
  const holdSpec = researchSpecSchema.parse({
    ...spec,
    strategy: "canslim-priority-hold3",
  });
  const holdDataset = { ...dataset, method: researchMethodSnapshot(holdSpec) };
  const holdEvidence = structuredClone(evidence);
  holdEvidence.corporateActionFree[0]!.start = input[0]!.date;
  const held = await runStrategyResearch(
    holdSpec,
    holdDataset,
    holdEvidence,
    native,
  );
  expect(held.events).toHaveLength(1);
  expect(held.events[0]!.observedDate).toBe(input[72]!.date);
  expect(JSON.parse(held.events[0]!.evidence).hold).toMatchObject({
    breakoutDate: input[69]!.date,
    confirmationDate: input[72]!.date,
  });
  expect(held.partitions[0]!.simulation!.trades[0]!.entryDate).toBe(
    input[73]!.date,
  );
  holdEvidence.corporateActionFree[0]!.start = input[1]!.date;
  expect(
    (
      await runStrategyResearch(holdSpec, holdDataset, holdEvidence, native)
    ).partitions.every((p) => p.simulation!.trades.length === 0),
  ).toBe(true);
  evidence.corporateActionFree[0]!.start = input[1]!.date;
  const missing = await runStrategyResearch(spec, dataset, evidence, native);
  expect(missing.events).toHaveLength(1);
  const actionDataset = structuredClone(dataset);
  actionDataset.stocks[0]!.actions = [
    {
      date: input[0]!.date,
      category: 1,
    } as (typeof actionDataset.stocks)[0]["actions"][number],
  ];
  const rejected = await runStrategyResearch(
    spec,
    actionDataset,
    evidence,
    native,
  );
  expect(rejected.events).toEqual([]);
  expect(
    missing.partitions.every((p) => p.simulation!.trades.length === 0),
  ).toBe(true);
});
