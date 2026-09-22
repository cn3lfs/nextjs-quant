import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  canslimSaucerIds,
  canslimSaucerShape,
  canslimShapeWarmup,
} from "../src/lib/research-canslim-strategies";
import { researchCanslimSaucerPoint } from "../src/server/strategies/canslim/research-canslim-saucer";
import { researchRuleSeries } from "../src/server/strategies/shared/research-rule-series";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

function fixture(shape: "U" | "W"): Bar[] {
  return Array.from({ length: 174 }, (_, i) => {
    let high =
      i < 130 ? 100 : i < 160 ? 93 + 7 * ((i - 144.5) / 14.5) ** 2 : 103;
    if (shape === "W" && i >= 130 && i < 160) {
      const knots = [
        [130, 100],
        [138, 94],
        [145, 99],
        [152, 94],
        [159, 100],
      ] as const;
      const right = Math.max(
        1,
        knots.findIndex(([index]) => index >= i),
      );
      const a = knots[right - 1]!,
        b = knots[right]!;
      high = a[1] + ((b[1] - a[1]) * (i - a[0])) / (b[0] - a[0]);
    }
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      high,
      low: i > 160 ? 101 : high - 1,
      open: high - 0.5,
      close: high - 0.2,
      volume: i < 130 ? 100 : i < 160 ? 30 : 200,
      amount: 1000000,
    };
  });
}

it.each(["U", "W"] as const)(
  "%s keeps its geometry and original pivot with prefix-only confirmation",
  (shape) => {
    const bars = fixture(shape);
    const point = researchCanslimSaucerPoint(shape, bars.slice(0, 161));
    expect(point).toMatchObject({
      entry: true,
      maxEntryPrice: 105,
      candidate: { shape, high: 100, qualified: true },
    });
    expect(point.candidate!.points).toBe(shape === "U" ? 10 : 9);
    expect(point.candidate!.length).toBeLessThanOrEqual(120);
    expect(
      researchCanslimSaucerPoint(shape === "U" ? "W" : "U", bars.slice(0, 161))
        .entry,
    ).toBe(false);
    if (shape === "W")
      expect(point.candidate!.doubleBottom).toMatchObject({
        second: bars[152]!.date,
        secondConfirmedAt: bars[155]!.date,
      });
    expect(researchCanslimSaucerPoint(shape, bars.slice(0, 160)).entry).toBe(
      false,
    );
    const id = shape === "U" ? "canslim-saucer-u" : "canslim-saucer-w";
    const before = researchRuleSeries(id, bars);
    const future = structuredClone(bars);
    future[166]!.high = 1000;
    expect(researchRuleSeries(id, future).slice(0, 166)).toEqual(
      before.slice(0, 166),
    );
  },
);

it("requires breakout volume and the 1%/5% price interval without treating invalid bars as no signal", () => {
  const bars = fixture("U").slice(0, 161);
  for (const close of [101, 105.01]) {
    const changed = structuredClone(bars);
    Object.assign(changed[160]!, {
      close,
      high: Math.max(106, close),
      low: 100,
    });
    expect(researchCanslimSaucerPoint("U", changed)).toMatchObject({
      entry: false,
      reason: null,
    });
  }
  const lowVolume = structuredClone(bars);
  lowVolume[160]!.volume = 1;
  expect(researchCanslimSaucerPoint("U", lowVolume)).toMatchObject({
    entry: false,
    reason: null,
  });
  lowVolume[160]!.volume = 0;
  expect(researchCanslimSaucerPoint("U", lowVolume).reason).not.toBeNull();
  expect(
    researchCanslimSaucerPoint("U", bars.slice(-45)).reason,
  ).not.toBeNull();
});

it.each(["canslim-saucer-u-hold3", "canslim-saucer-w-hold3"] as const)(
  "%s confirms only after three aligned lows hold the original pivot",
  (id) => {
    const bars = fixture(canslimSaucerShape(id));
    const calendar = bars.map((b) => b.date);
    const run = (input = bars) => researchRuleSeries(id, input, calendar);
    expect(
      run()
        .filter((p) => p.entry)
        .map((p) => p.date),
    ).toEqual([bars[163]!.date]);
    expect(run(bars.slice(0, 163)).some((p) => p.entry)).toBe(false);
    expect(run(bars.filter((_, i) => i !== 162)).some((p) => p.entry)).toBe(
      false,
    );
    bars[162]!.low = 99.99;
    expect(run().some((p) => p.entry)).toBe(false);
    bars[162]!.low = 100;
    expect(run()[163]!.entry).toBe(true);
  },
);

it("runs all four presets with frozen prices and 140/143-bar company-action coverage", async () => {
  const native = async (): Promise<never> => {
    throw Error("unexpected native");
  };
  const rules = {
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
  for (const strategy of canslimSaucerIds) {
    const bars = fixture(canslimSaucerShape(strategy));
    const held = strategy.endsWith("-hold3");
    const signalIndex = held ? 163 : 160;
    const spec = researchSpecSchema.parse({
      strategy,
      symbols: ["sh600000"],
      start: bars[151]!.date,
      end: bars[173]!.date,
      validationStart: bars[170]!.date,
      holdingDays: 2,
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    });
    const events = await researchSignals("sh600000", bars, spec, native);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      observedDate: bars[signalIndex]!.date,
      entryPriceRange: { min: 100, max: 105 },
    });
    const point = JSON.parse(events[0]!.evidence);
    expect(point.candidate.shape).toBe(canslimSaucerShape(strategy));
    if (held)
      expect(point.hold).toMatchObject({
        breakoutDate: bars[160]!.date,
        confirmationDate: bars[163]!.date,
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
    const startIndex = 151 - canslimShapeWarmup(strategy);
    const evidence = researchMarketEvidenceSchema.parse({
      version: "research-market-evidence-1",
      source: "fixture",
      exportedAt: 0,
      adjustment: "none",
      corporateActionFree: [
        {
          symbol: "sh600000",
          start: bars[startIndex]!.date,
          end: spec.end,
          evidenceId: "fixture",
        },
      ],
      rows: bars.map((b) => ({
        symbol: "sh600000",
        date: b.date,
        ...rules,
        evidenceId: "fixture",
      })),
    });
    const result = await runStrategyResearch(spec, dataset, evidence, native);
    expect(result.partitions[0]!.simulation!.trades[0]).toMatchObject({
      entryDate: bars[signalIndex + 1]!.date,
      exitDate: bars[signalIndex + 3]!.date,
    });
    // canslim-saucer is not a cup strategy, so admission runs on the
    // stock-wide prepareResearchAdjustedCoverage gate only; corporateActionFree
    // is legacy evidence metadata the engine no longer consumes, so
    // shrinking it must not change the trade.
    evidence.corporateActionFree[0]!.start = bars[startIndex + 1]!.date;
    expect(
      (await runStrategyResearch(spec, dataset, evidence, native))
        .partitions[0]!.simulation!.trades,
    ).toEqual(result.partitions[0]!.simulation!.trades);
    evidence.corporateActionFree[0]!.start = bars[startIndex]!.date;
    bars[signalIndex + 1]!.open = 106;
    bars[signalIndex + 1]!.high = 106;
    expect(
      (
        await runStrategyResearch(spec, dataset, evidence, native)
      ).partitions.every((p) => p.simulation!.trades.length === 0),
    ).toBe(true);
  }
});
