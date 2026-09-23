import { expect, it, vi } from "vitest";
import type { ResearchDataset } from "../../src/server/backtest/research-dataset";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { researchMarketEvidenceSchema } from "../../src/lib/research/factors/research-market-evidence";
import { growthIntradayTemplate } from "../../src/lib/research/factors/research-growth-intraday";
import { growthMinuteTimes } from "../../src/server/strategies/canslim/research-growth-intraday";
import { runStrategyResearch } from "../../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../../src/server/research/research-method";
import { ResearchStore } from "../../src/server/backtest/research-store";
import { migrate } from "../../src/server/db/migrations";
import Database from "better-sqlite3";

it("real shape to minute transactions preserves provenance and rejects insufficient action coverage", async () => {
  const bars = Array.from({ length: 77 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 69 ? 102 : 97,
    close: i >= 69 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 69 ? 101 : 95,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 100000,
  }));
  const minutes = bars.flatMap((b) =>
    growthMinuteTimes.map((time) => ({
      ...b,
      date: `${b.date}T${time}:00+08:00`,
    })),
  );
  const spec = researchSpecSchema.parse({
    strategy: "canslim-priority",
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[76]!.date,
    validationStart: bars[75]!.date,
    holdingDays: 2,
    risk: { fraction: 0.015, maxWeight: 0.25 },
    management: growthIntradayTemplate("CA-D-review1430"),
    costs: {
      slippageBps: 0,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
    },
  });
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
        minuteBars: minutes,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: null,
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(spec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "synthetic execution scenario",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[0]!.date,
        end: spec.end,
        evidenceId: "synthetic",
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
      evidenceId: "synthetic",
    })),
  });
  const native = vi.fn(async (): Promise<never> => {
    throw Error("unexpected native");
  });
  const r = await runStrategyResearch(spec, dataset, evidence, native);
  expect(r.events).toHaveLength(1);
  expect(r.partitions[0]!.simulation!.trades[0]).toMatchObject({
    entryDate: bars[70]!.date,
    exitDate: bars[72]!.date,
  });
  expect(r.warnings.join(" ")).toContain("日线输入区间");
  expect(r.warnings.join(" ")).toContain("五分钟输入区间");
  expect(native).not.toHaveBeenCalled();
  const absent = await runStrategyResearch(
    spec,
    {
      ...dataset,
      stocks: dataset.stocks.map((s) => ({ ...s, minuteBars: [] })),
    },
    evidence,
    native,
  );
  expect(absent.partitions[0]!.simulation!.trades).toEqual([]);
  expect(absent.partitions[0]!.simulation!.signalGaps!.length).toBeGreaterThan(
    0,
  );
  evidence.corporateActionFree[0]!.start = spec.start;
  const uncovered = await runStrategyResearch(spec, dataset, evidence, native);
  expect(uncovered.partitions[0]!.simulation!.trades).toEqual([]);
  const db = new Database(":memory:");
  try {
    migrate(db);
    const store = new ResearchStore(db),
      task = store.create(spec, null);
    expect(store.task(task.id)!.spec).toEqual(spec);
  } finally {
    db.close();
  }
});
