import { expect, it } from "vitest";
import {
  growthPivotStopIds,
  growthPivotStopTemplate,
  researchGrowthPivotStop,
} from "../src/lib/research-growth-stops";
import {
  researchInitialStop,
  researchManagementSchema,
} from "../src/lib/research-management";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchMethodSnapshot } from "../src/server/research-method";
import { researchPortfolio } from "../src/server/research-portfolio";
it("keeps the contradictory MIN/MAX and CANSLIM pivot formula distinct", () => {
  expect(researchGrowthPivotStop("sepa-pivot-min", 50, 48)).toBeCloseTo(44.16);
  expect(researchGrowthPivotStop("sepa-pivot-max", 50, 48)).toBe(45);
  expect(researchGrowthPivotStop("canslim-pivot-max", 50, 48)).toBe(46);
  expect(researchGrowthPivotStop("canslim-pivot-max", 50, 52)).toBeCloseTo(
    47.84,
  );
});
it.each(growthPivotStopIds)(
  "%s rejects missing/invalid pivot and preserves exact identity",
  (kind) => {
    const management = researchManagementSchema.parse(
      growthPivotStopTemplate(kind),
    );
    for (const pivot of [undefined, 0, -1, NaN, Infinity])
      expect(researchGrowthPivotStop(kind, 50, pivot)).toBeNull();
    expect(researchInitialStop(management, 50, {})).toBeNull();
    expect(
      researchInitialStop(management, 50, {
        entryPriceRange: { min: 48, max: 50.4 },
      }),
    ).toBe(researchGrowthPivotStop(kind, 50, 48));
    expect(
      researchMethodSnapshot({ strategy: "sepa-vcp-close", management }),
    ).toMatchObject({
      growthPivotStop: { kind, version: "growth-pivot-stop-1" },
    });
  },
);
it("sizes from the actual different stop distances, executes next day, and never substitutes an absent pivot", () => {
  const bars = Array.from({ length: 6 }, (_, i) => ({
    date: `2021-01-0${i + 1}`,
    open: i === 1 ? 50 : 44.5,
    close: 44.5,
    high: 51,
    low: 44,
    volume: 10000,
    amount: 500000,
  }));
  for (const [kind, quantity, exitIndex] of [
    ["sepa-pivot-min", 2500, 4],
    ["sepa-pivot-max", 3000, 2],
    ["canslim-pivot-max", 3700, 2],
  ] as const) {
    const spec = researchSpecSchema.parse({
      strategy: kind.startsWith("sepa") ? "sepa-vcp-close" : "canslim-priority",
      start: bars[0]!.date,
      end: bars[5]!.date,
      validationStart: bars[5]!.date,
      initialCapital: 1000000,
      holdingDays: 3,
      risk: { fraction: 0.015, maxWeight: 0.25 },
      management: growthPivotStopTemplate(kind),
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    });
    const event = {
      symbol: "sh600000",
      observedDate: bars[0]!.date,
      endpointDate: bars[0]!.date,
      key: "entry",
      strategyVersion: "fixture",
      partition: "development" as const,
      evidence: "synthetic entry",
      entryPriceRange: { min: 48, max: 50.4 },
    };
    const run = (range = true) =>
      researchPortfolio(
        spec,
        [{ ...event, ...(!range ? { entryPriceRange: undefined } : {}) }],
        bars.map((b) => b.date),
        new Map([["sh600000", bars]]),
        () => ({
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
        }),
      );
    const trade = run().trades[0]!;
    expect(trade.quantity).toBe(quantity);
    expect(trade.exitDate).toBe(bars[exitIndex]!.date);
    expect(trade.initialStop).toBe(researchGrowthPivotStop(kind, 50, 48));
    expect(run(false).trades).toHaveLength(0);
  }
});
