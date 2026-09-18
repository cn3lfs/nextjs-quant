import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  canslimHighIds,
  canslimHighWarmupStart,
} from "../src/lib/research-canslim-strategies";
import { researchCanslimHighSeries } from "../src/server/research-canslim-high";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { runStrategyResearch } from "../src/server/research-run";
import { researchMethodSnapshot } from "../src/server/research-method";
import type { ResearchDataset } from "../src/server/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

const bars = (): Bar[] =>
  Array.from({ length: 380 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i < 365 ? 89 : i === 365 ? 90 : i === 366 ? 95 : i === 367 ? 98 : 100,
    close:
      i < 365 ? 89 : i === 365 ? 90 : i === 366 ? 95 : i === 367 ? 98 : 100,
    high: 100,
    low: 80,
    volume: 100,
    amount: 1000000,
  }));

it.each(canslimHighIds)(
  "%s crosses its own inclusive score boundary once without a volume gate",
  (id) => {
    const input = bars();
    const index = 365 + canslimHighIds.indexOf(id);
    const points = researchCanslimHighSeries(id, input);
    expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
      input[index]!.date,
    ]);
    expect(points[index]!.diagnostic).toMatchObject({
      high52Weeks: 100,
      windowBars: 364,
    });
    expect(points[index]!.diagnostic!.breakoutVolumeConfirmed).toBe(
      id === "canslim-high-100" ? false : null,
    );
    expect(points[364]!.reason).toContain("前一观察");
    expect(points[363]!.reason).toContain("缺少");
  },
);

it("rearms after falling below the tier and never backfills a signal from future data", () => {
  const input = bars();
  input[374]!.close = 89;
  input[375]!.close = 95;
  const points = researchCanslimHighSeries("canslim-high-95", input);
  expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
    input[366]!.date,
    input[375]!.date,
  ]);
  const future = structuredClone(input);
  future[377]!.high = 1000;
  expect(
    researchCanslimHighSeries("canslim-high-95", future).slice(0, 377),
  ).toEqual(points.slice(0, 377));
  expect(
    researchCanslimHighSeries("canslim-high-95", input.slice(0, 366)).some(
      (p) => p.entry,
    ),
  ).toBe(false);
});

it("does not turn incomplete, invalid or first-known scores into threshold crossings", () => {
  for (const change of ["short", "invalid", "first-known"] as const) {
    const input = bars().slice(0, 366);
    if (change === "short") input.splice(0, 10);
    if (change === "invalid") input[360]!.volume = 0;
    if (change === "first-known") input[364]!.close = 95;
    expect(
      researchCanslimHighSeries("canslim-high-90", input).some((p) => p.entry),
    ).toBe(false);
  }
});

it("uses natural days, excludes the left endpoint high, and allows a falling rolling high to cross", () => {
  const input = bars().slice(0, 366);
  input.forEach((b) => {
    b.close = 95;
    b.high = 100;
  });
  input[1]!.high = 200;
  const points = researchCanslimHighSeries("canslim-high-95", input);
  expect(points[364]!.diagnostic!.points).toBe(0);
  expect(points[365]).toMatchObject({
    entry: true,
    previousPoints: 0,
    diagnostic: { high52Weeks: 100, points: 6 },
  });
  expect(canslimHighWarmupStart(input, input[365]!.date)).toBe(input[0]!.date);
  // Weekend-like gaps preserve calendar-week semantics, not a 252-bar substitution.
  const sparse = input.filter((_, i) => i % 7 !== 5 && i % 7 !== 6);
  expect(
    researchCanslimHighSeries("canslim-high-95", sparse).at(-1)!.diagnostic!
      .high52Weeks,
  ).toBe(100);
});

it("runs all registered tiers through saved method, events and transactions with full prior action coverage", async () => {
  const input = bars();
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
  for (const strategy of canslimHighIds) {
    const spec = researchSpecSchema.parse({
      strategy,
      symbols: ["sh600000"],
      start: input[365]!.date,
      end: input[379]!.date,
      validationStart: input[377]!.date,
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
    const index = 365 + canslimHighIds.indexOf(strategy);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.observedDate).toBe(input[index]!.date);
    expect(result.events[0]).not.toHaveProperty("entryPriceRange");
    expect(result.partitions[0]!.simulation!.trades[0]).toMatchObject({
      entryDate: input[index + 1]!.date,
      exitDate: input[index + 3]!.date,
    });
    // canslim-high is not a cup strategy, so admission runs on the stock-wide
    // prepareResearchAdjustedCoverage gate only; corporateActionFree is
    // legacy evidence metadata the engine no longer consumes, so shrinking
    // it must not change the trade.
    evidence.corporateActionFree[0]!.start = input[1]!.date;
    const missing = await runStrategyResearch(spec, dataset, evidence, native);
    expect(missing.events).toHaveLength(1);
    expect(missing.partitions[0]!.simulation!.trades).toEqual(
      result.partitions[0]!.simulation!.trades,
    );
    // A bare category-1 record (no dividend/bonus/rights amounts) has zero
    // price effect, so adjustmentFactors computes a complete, unperturbed
    // factor series for it — admission is decided by whether the price
    // adjustment prefix is derivable, not by whether any action exists in
    // the window, so this must not exclude the stock either.
    dataset.stocks[0]!.actions.push({
      date: input[1]!.date,
      category: 1,
      name: "fixture除权",
    });
    const action = await runStrategyResearch(spec, dataset, evidence, native);
    expect(action.events).toHaveLength(1);
  }
});

it("keeps the entry 98% binary rule separate from both reference tiers", () => {
  const input = bars();
  input[366]!.close = 97.99;
  input[367]!.close = 98;
  input[368]!.close = 97;
  input[369]!.close = 98;
  const points = researchCanslimHighSeries("canslim-high-98", input);
  expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
    input[367]!.date,
    input[369]!.date,
  ]);
  expect(points[366]!.diagnostic).toMatchObject({
    points: 0,
    version: "canslim-new-high-entry98-1",
  });
  expect(points[367]!.diagnostic).toMatchObject({
    points: 9,
    high52Weeks: 100,
  });
  expect(
    researchCanslimHighSeries("canslim-high-95", input)[366]!.diagnostic!
      .points,
  ).toBe(6);
  expect(researchCanslimHighSeries("canslim-high-100", input)[367]!.entry).toBe(
    false,
  );
  expect(
    researchCanslimHighSeries("canslim-high-98", input.slice(0, 369)),
  ).toEqual(points.slice(0, 369));
  const missing = bars();
  missing[360]!.volume = 0;
  expect(
    researchCanslimHighSeries("canslim-high-98", missing).some((p) => p.entry),
  ).toBe(false);
  const spec = researchSpecSchema.parse({
    strategy: "canslim-high-98",
    symbols: ["sh600000"],
    start: input[365]!.date,
    end: input[379]!.date,
    validationStart: input[377]!.date,
  });
  expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
    "canslim-analyst/SKILL.md",
  );
});
