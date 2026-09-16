import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchSepaElite } from "../src/lib/research-sepa-elite";
import { growthDailyExitTemplate } from "../src/lib/research-growth-exits";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";

function fixture() {
  const bars: Bar[] = Array.from({ length: 65 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: i < 3 ? 100 : 120,
    close: i < 2 ? 100 : 120,
    high: 121,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
  const dates = bars.map((b) => b.date),
    input = new Map(bars.map((b) => [b.date, b]));
  const spec = growthDailyExitTemplate(
    researchSpecSchema.parse({
      strategy: "sepa-vcp-exits-elite",
      start: dates[0],
      end: dates[64],
      validationStart: dates[63],
      initialCapital: 1000000,
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    }),
  );
  const run = (data = bars, blocked = "") =>
    researchPortfolio(
      spec,
      [
        {
          symbol: "sh600000",
          observedDate: dates[0]!,
          endpointDate: dates[0]!,
          key: "entry",
          strategyVersion: "sepa-vcp-exits-elite-1",
          partition: "development",
          evidence: "synthetic entry for elite execution",
        },
      ],
      dates,
      new Map([["sh600000", data]]),
      (_, d) => ({
        evidence: "fixture",
        tradable: d !== blocked,
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
  return { bars, dates, input, spec, run };
}
it("retains exact 21-day/20-percent boundaries, no late activation, no missing calendar repair", () => {
  const { bars, dates, input } = fixture();
  const entry = { entryDate: dates[1]!, entryPrice: 100 };
  expect(researchSepaElite(entry, dates[22]!, dates, input)).toMatchObject({
    elapsed: 21,
    holdUntil: dates[57],
  });
  expect(researchSepaElite(entry, dates[23]!, dates, input)).toBeNull();
  bars[22]!.close = 119.999;
  expect(researchSepaElite(entry, dates[22]!, dates, input)).toBeNull();
  bars[22]!.close = 120;
  input.delete(dates[10]!);
  expect(researchSepaElite(entry, dates[22]!, dates, input)).toBeNull();
});
it("freezes the eight-week deadline, sells profit stage, and retries blocked expiry", () => {
  const { bars, dates, run } = fixture();
  const result = run(bars, dates[57]);
  const trade = result.trades[0]!;
  expect(trade.sepaElite).toMatchObject({
    confirmedDate: dates[2],
    holdUntil: dates[57],
  });
  expect(trade.sales?.map((s) => [s.date, s.quantity])).toEqual([
    [dates[3], 500],
    [dates[58], 1000],
  ]);
  expect(trade.exitDate).toBe(dates[58]);
  const prefix = researchSepaElite(
    { entryDate: dates[1]!, entryPrice: 100 },
    dates[2]!,
    dates.slice(0, 3),
    new Map(bars.slice(0, 3).map((b) => [b.date, b])),
  );
  expect(prefix).toEqual(trade.sepaElite);
});
it("never revokes stop loss to hold eight weeks and refuses activation across a missing day", () => {
  const { bars, dates, run } = fixture();
  bars[8]!.close = 99;
  bars[8]!.low = 98;
  const trade = run().trades[0]!;
  expect(trade.sepaElite).toBeDefined();
  expect(trade.exitDate).toBe(dates[9]);
  const missing = fixture();
  missing.bars[2]!.close = 100;
  const result = missing.run(missing.bars.filter((_, i) => i !== 2));
  expect(result.trades[0]!.sepaElite).toBeUndefined();
  expect(result.trades[0]!.exitDate).toBe(missing.dates[21]);
});
