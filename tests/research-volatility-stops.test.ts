import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  volatilityStopIds,
  volatilityStopSeries,
  volatilityStopTemplate,
} from "../src/lib/research-volatility-stops";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";

const bars = (n = 130): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1000,
    amount: 100000,
  }));
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2021-01-01",
  end: "2021-05-10",
  validationStart: "2021-04-01",
  holdingDays: 60,
});

it.each(volatilityStopIds)(
  "%s has a frozen independent baseline and saved interpretation",
  (id) => {
    const template = volatilityStopTemplate(id);
    expect(researchManagementSchema.parse(template)).toEqual(template);
    const spec = applyResearchManagement(base, template);
    expect(researchSpecSchema.parse(spec).strategy).toBe("dual-breakout");
    expect(spec.risk).toEqual({ fraction: 0.01, maxWeight: 0.2 });
    expect(
      researchManagementSchema.safeParse({ ...template, confirmations: 2 })
        .success,
    ).toBe(false);
    expect(
      researchSpecSchema.safeParse({ ...spec, strategy: "czsc" }).success,
    ).toBe(false);
    expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
      "volatility-stops-1",
    );
  },
);

it.each(volatilityStopIds)(
  "%s computes the hand-calculated flat-price line and unknown windows",
  (id) => {
    const input = bars();
    // Flat closes: STD=0, EMA=MA=100; H-L=TR=4; high-2*range=94.
    const expected =
      id === "rk-keltner-lower" ? 92 : id === "rk-kaufman" ? 94 : 100;
    expect(volatilityStopSeries(input, id).at(-1)).toBe(expected);
    expect(
      volatilityStopSeries(input.slice(0, 19), id).every((v) => v === null),
    ).toBe(true);
    input[129]!.open = 200;
    expect(volatilityStopSeries(input, id).at(-1)).toBeNull();
    input[129]!.open = 100;
    input[129]!.volume = 0;
    expect(volatilityStopSeries(input, id).at(-1)).toBeNull();
  },
);

it("Kaufman excludes gaps while Keltner ATR includes them; BOLL uses sample deviation", () => {
  const input = bars(21);
  for (const b of input.slice(1))
    Object.assign(b, { open: 110, close: 110, high: 112, low: 108 });
  // Range stays 4; first post-gap TR=12, then nineteen TR=4 => ATR=4.4.
  expect(volatilityStopSeries(input, "rk-kaufman").at(-1)).toBe(104);
  const ema = 110 - 10 * Math.pow(19 / 21, 20);
  expect(volatilityStopSeries(input, "rk-keltner-lower").at(-1)).toBeCloseTo(
    ema - 8.8,
    10,
  );
  const sample = bars(20);
  Object.assign(sample[19]!, { open: 120, close: 120, high: 122, low: 118 });
  // Mean=101, sample variance=(19*1+361)/19=20.
  expect(volatilityStopSeries(sample, "rk-boll-lower").at(-1)).toBeCloseTo(
    101 - 2 * Math.sqrt(20),
    10,
  );
});

it("a missing expected trading day invalidates the rolling input until it leaves the window", () => {
  const input = bars(45);
  const calendar = input.map((b) => b.date);
  const gap = input.filter((_, i) => i !== 23);
  expect(volatilityStopSeries(gap, "rk-boll-mid", calendar)[30]).toBeNull();
  expect(volatilityStopSeries(gap, "rk-boll-mid", calendar).at(-1)).toBe(100);
});

it("portfolio ratchets a falling candidate and executes equality at the next open", () => {
  const input = bars(28);
  // Buy day 21 at 100. Day 21 stop becomes 100, effective on day 22.
  input[21] = { ...input[21]!, close: 110, high: 112 };
  input[22] = { ...input[22]!, close: 105, high: 112 };
  input[23] = { ...input[23]!, close: 99, low: 97 };
  const spec = researchSpecSchema.parse({
    ...applyResearchManagement(base, volatilityStopTemplate("rk-boll-mid")),
    end: input[27]!.date,
    validationStart: input[26]!.date,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: input[19]!.date,
    endpointDate: input[19]!.date,
    key: "volatility-test",
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
  };
  const result = researchPortfolio(
    spec,
    [event],
    input.map((b) => b.date),
    new Map([[event.symbol, input]]),
    () => ({
      evidence: "fixture",
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      minimumSell: 100,
      sellStep: 100,
      maximumSell: 100000,
      sellOddLotAll: true,
      limitUp: null,
      limitDown: null,
      tradable: true,
    }),
  );
  const trade = result.trades[0]!;
  expect(trade.entryDate).toBe(input[20]!.date);
  expect(trade.exitDate).toBe(input[24]!.date);
  const stops = trade.stopHistory!.map((s) => s.stop);
  expect(stops).toEqual([...stops].sort((a, b) => a - b));
  expect(stops).toContain(100.75);
});
