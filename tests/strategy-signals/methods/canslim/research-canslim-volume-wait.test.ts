import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { researchRuleSeries } from "../../../../src/server/strategies/shared/research-rule-series";
import { researchSpecSchema } from "../../../../src/lib/research/strategy-research";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";
import { runStrategyResearch } from "../../../../src/server/backtest/research-run";
import type { ResearchDataset } from "../../../../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../../../../src/lib/research/factors/research-market-evidence";

function fixture(confirm = 72): Bar[] {
  return Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : i === confirm ? 100 : 20,
    amount: 1000000,
  }));
}
const ids = [
  "canslim-priority-volume-wait3",
  "canslim-priority-volume-wait5",
] as const;

it.each(ids)(
  "%s freezes the original pivot and confirms only within the explicit calendar deadline",
  (id) => {
    const max = id.endsWith("3") ? 3 : 5;
    for (const elapsed of [1, max, max + 1]) {
      const bars = fixture(69 + elapsed);
      const points = researchRuleSeries(id, bars);
      expect(points[69]).toMatchObject({
        entry: false,
        volumeWait: {
          status: "waiting",
          breakoutDate: bars[69]!.date,
          pivot: 100,
          initialVolume20: 40,
        },
      });
      expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual(
        elapsed <= max ? [bars[69 + elapsed]!.date] : [],
      );
      if (elapsed <= max)
        expect(points[69 + elapsed]).toMatchObject({
          candidate: { family: "flat", high: 100 },
          historyStart: bars[0]!.date,
          volumeWait: {
            status: "confirmed",
            confirmationDate: bars[69 + elapsed]!.date,
            elapsed,
          },
        });
      else
        expect(points[69 + max]).toMatchObject({
          volumeWait: { status: "expired" },
        });
      expect(researchRuleSeries(id, bars.slice(0, 70 + elapsed))).toEqual(
        points.slice(0, 70 + elapsed),
      );
    }
  },
);

it("uses strict initial volume below one mean and inclusive confirmation at 1.5 means", () => {
  for (const volume of [39.99, 40, 50, 60]) {
    const bars = fixture(70);
    bars[69]!.volume = volume;
    const average = bars
      .slice(50, 70)
      .reduce((sum, b) => sum + b.volume / 20, 0);
    bars[70]!.volume = average * 1.5;
    const points = researchRuleSeries(ids[0], bars);
    expect(points.some((p) => p.entry)).toBe(volume < 40);
    if (volume < 40) {
      expect(points[70]!.entry).toBe(true);
      bars[70]!.volume -= 0.0001;
      expect(researchRuleSeries(ids[0], bars)[70]!.entry).toBe(false);
    }
  }
});

it("cancels close breaches, chase, missing days and invalid bars without replacing the pending shape", () => {
  for (const patch of [
    { low: 98, close: 99 },
    { high: 107, close: 106 },
    { volume: 0 },
  ]) {
    const bars = fixture(72);
    Object.assign(bars[70]!, patch);
    const points = researchRuleSeries(ids[0], bars);
    expect(points[70]).toMatchObject({
      entry: false,
      volumeWait: { status: "cancelled", pivot: 100 },
    });
    expect(points.some((p) => p.entry)).toBe(false);
  }
  const bars = fixture(72),
    calendar = bars.map((b) => b.date);
  const points = researchRuleSeries(
    ids[0],
    bars.filter((_, i) => i !== 70),
    calendar,
  );
  expect(points.find((p) => p.date === bars[71]!.date)).toMatchObject({
    volumeWait: { status: "cancelled" },
  });
  expect(points.some((p) => p.entry)).toBe(false);
});

it("allows intraday pivot touches and close equality while waiting, but confirmation must exceed 101 percent", () => {
  const bars = fixture(72);
  Object.assign(bars[70]!, { low: 99, close: 100 });
  Object.assign(bars[71]!, { close: 101, volume: 100 });
  const points = researchRuleSeries(ids[0], bars);
  expect(points[70]).toMatchObject({
    entry: false,
    volumeWait: { status: "waiting" },
  });
  expect(points[71]).toMatchObject({
    entry: false,
    volumeWait: { status: "waiting" },
  });
  expect(points[72]).toMatchObject({
    entry: true,
    volumeWait: {
      breakoutDate: bars[69]!.date,
      confirmationDate: bars[72]!.date,
    },
  });
});

it.each(ids)(
  "%s enters after confirmation with original proof and fill bounds",
  async (strategy) => {
    const bars = fixture(strategy.endsWith("3") ? 72 : 74);
    const index = strategy.endsWith("3") ? 72 : 74;
    const spec = researchSpecSchema.parse({
      strategy,
      symbols: ["sh600000"],
      start: bars[61]!.date,
      end: bars[79]!.date,
      validationStart: bars[78]!.date,
      holdingDays: 2,
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
      root: "fixture",
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
        evidenceId: "fixture",
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
      })),
    });
    const run = () =>
      runStrategyResearch(spec, dataset, evidence, async () => {
        throw Error("unexpected native");
      });
    const result = await run();
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      observedDate: bars[index]!.date,
      endpointDate: bars[index]!.date,
      historyStart: bars[0]!.date,
      entryPriceRange: { min: 100, max: 105 },
    });
    expect(result.partitions[0]!.simulation!.trades[0]).toMatchObject({
      entryDate: bars[index + 1]!.date,
      exitDate: bars[index + 3]!.date,
    });
    evidence.corporateActionFree[0]!.start = bars[1]!.date;
    const missing = await run();
    expect(missing.events).toHaveLength(1);
    expect(missing.partitions[0]!.simulation!.trades).toEqual([]);
    evidence.corporateActionFree[0]!.start = bars[0]!.date;
    Object.assign(bars[index + 1]!, { open: 106, high: 107 });
    expect((await run()).partitions[0]!.simulation!.trades).toEqual([]);
    dataset.stocks[0]!.actions = [
      { date: bars[70]!.date, category: 1, name: "fixture" },
    ];
    expect((await run()).events).toEqual([]);
  },
);
