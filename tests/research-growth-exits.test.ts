import { expect, it } from "vitest";
import { maParamsSchema, type Bar } from "../src/lib/domain";
import {
  growthDailyExitIds,
  growthDailyExitTemplate,
} from "../src/lib/research-growth-exits";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { selectResearchStrategy } from "../src/components/research-strategy-fields";

function setup(id: (typeof growthDailyExitIds)[number]) {
  const bars: Bar[] = Array.from({ length: 45 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    amount: 100000,
  }));
  const spec = growthDailyExitTemplate(
    researchSpecSchema.parse({
      strategy: id,
      start: bars[0]!.date,
      end: bars[44]!.date,
      validationStart: bars[43]!.date,
      initialCapital: 1000000,
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    }),
  );
  const run = (blocked = "") =>
    researchPortfolio(
      spec,
      [
        {
          symbol: "sh600000",
          observedDate: bars[0]!.date,
          endpointDate: bars[0]!.date,
          key: "entry",
          strategyVersion: `${id}-1`,
          partition: "development",
          evidence: "synthetic entry for exit execution",
          entryPriceRange: { min: 98, max: 102 },
        },
      ],
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      (_, date) => ({
        evidence: "fixture",
        tradable: date !== blocked,
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
  return { bars, spec, run };
}
it.each(growthDailyExitIds)(
  "%s resets stale settings and snapshots exact configuration",
  (id) => {
    const { spec } = setup(id);
    const selected = selectResearchStrategy(
      { ...spec, strategy: "ma-cross", maParams: maParamsSchema.parse({}) },
      id,
    );
    expect(selected.maParams).toBeUndefined();
    expect(selected.management).toEqual(spec.management);
    expect(researchSpecSchema.parse(selected).holdingDays).toBe(
      id.endsWith("elite") ? 20 : 60,
    );
    expect(researchMethodSnapshot(selected)).toMatchObject({
      growthDailyExit: {
        version: "growth-daily-exit-1",
        configuration: spec.management,
      },
    });
  },
);
it.each(growthDailyExitIds)(
  "%s executes targets only next day and raises line only after actual fill",
  (id) => {
    const { bars, run } = setup(id);
    const second = id.startsWith("sepa") ? 130 : 125;
    for (let i = 2; i < bars.length; i++)
      Object.assign(bars[i]!, { open: 120, close: 120, high: 131, low: 119 });
    for (let i = 4; i < bars.length; i++)
      Object.assign(bars[i]!, {
        open: second,
        close: second,
        high: 131,
        low: 119,
      });
    const result = run(bars[3]!.date),
      trade = result.trades[0]!;
    expect(trade.entryDate).toBe(bars[1]!.date);
    expect(trade.sales!.map((f) => f.date).slice(0, 2)).toEqual([
      bars[4]!.date,
      bars[5]!.date,
    ]);
    expect(
      trade.stopHistory?.some(
        (s) => s.date === bars[3]!.date && s.reason.includes("实际成交"),
      ),
    ).toBe(false);
    // 15% breakeven has already raised to cost; selling stage one must not lower it.
    expect(trade.stopHistory?.filter((s) => s.stop < 100)).toHaveLength(1);
    if (id.startsWith("sepa")) {
      expect(trade.remainingQuantity).toBe(500);
      expect(trade.stopHistory?.find((s) => s.stop === 120)).toMatchObject({
        date: bars[5]!.date,
        reason: expect.stringContaining("实际成交"),
      });
    } else expect(trade.remainingQuantity).toBe(0);
  },
);
it.each(growthDailyExitIds)(
  "%s preserves forced stop and four-week exit",
  (id) => {
    const { bars, run } = setup(id);
    expect(run().trades[0]!.exitDate).toBe(
      bars[id.endsWith("elite") ? 21 : 30]!.date,
    );
    Object.assign(bars[2]!, { close: 89, low: 88 });
    const stop = run();
    expect(stop.trades[0]!.exitDate).toBe(bars[3]!.date);
  },
);
