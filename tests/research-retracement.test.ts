import { expect, it } from "vitest";
import { researchRetracementStop } from "../src/lib/research-retracement";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchMethodSnapshot } from "../src/server/research-method";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";

const dates = Array.from(
  { length: 8 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[7],
  validationStart: dates[6],
  initialCapital: 200000,
  holdingDays: 60,
  risk: { fraction: 0.025, maxWeight: 0.8 },
  management: {
    stop: { kind: "percent", fraction: 0.1 },
    trail: { kind: "retracement" },
  },
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[0]!,
  endpointDate: dates[0]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
};
const rules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 10000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 10000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function run(
  rows: number[][],
  management = spec.management!,
  cap = 10000,
  fraction = 0.025,
) {
  const bars = rows.map(([open, close, high], i) => ({
    date: dates[i]!,
    open: open!,
    close: close!,
    high: high!,
    low: Math.min(open!, close!) - 1,
    volume: 10000,
    amount: 1000000,
  }));
  return researchPortfolio(
    { ...spec, management, risk: { ...spec.risk!, fraction } },
    [event],
    bars.map((b) => b.date),
    new Map([[event.symbol, bars]]),
    () => ({ ...rules, maximumSell: cap }),
  );
}
it("activates only after the completed high and executes the next confirmed exit at the real gap", () => {
  const result = run([
    [100, 100, 101],
    [100, 110, 120],
    [110, 112, 115],
    [105, 106, 107],
  ]);
  const trade = result.trades[0]!;
  expect(trade.stopHistory!.map((r) => [r.date, r.stop])).toEqual([
    [dates[1], 90],
    [dates[1], 114],
  ]);
  expect(trade.exitDate).toBe(dates[3]);
  expect(trade.exitPrice).toBe(105);
  expect(trade.profit).toBe(2500);
  const prefix = run([
    [100, 100, 101],
    [100, 110, 120],
  ]).trades[0]!;
  expect(prefix.exitDate).toBeNull();
  expect(prefix.stopHistory).toEqual(trade.stopHistory);
});
it("keeps first-entry R after two profitable additions", () => {
  const management = researchManagementSchema.parse({
    ...spec.management,
    pyramid: { kind: "r-50-30-20", maxTotalWeight: 0.6 },
  });
  const trade = run(
    [
      [100, 100, 101],
      [100, 110, 111],
      [110, 120, 120],
      [120, 130, 130],
      [130, 140, 140],
      [140, 170, 170],
      [170, 165, 171],
      [160, 160, 161],
    ],
    management,
    10000,
    0.05,
  ).trades[0]!;
  expect(trade.entries).toHaveLength(3);
  expect(trade.entryPrice).toBe(100);
  expect(trade.initialStop).toBe(90);
  expect(trade.stopHistory!.map((r) => r.stop)).toContain(166.5);
  expect(trade.exitPrice).toBe(160);
});
it("waits for a capped scale-out to finish before activating the tail", () => {
  const management = researchManagementSchema.parse({
    ...spec.management,
    trailAfterScaleOut: true,
    scaleOut: [{ atR: 2, fraction: 0.4, raiseStopR: null }],
  });
  const rows = [
    [100, 100, 101],
    [100, 120, 120],
    [120, 130, 130],
    [130, 140, 140],
    [140, 145, 145],
  ];
  const before = run(rows.slice(0, 3), management, 100).trades[0]!;
  expect(before.stopHistory).toHaveLength(1);
  const after = run(rows, management, 100).trades[0]!;
  expect(after.stopHistory![1]).toMatchObject({ date: dates[3], stop: 132 });
  expect(after.entryPrice).toBe(100);
  expect(after.initialStop).toBe(90);
});
it("retains the specified fraction of peak profit rather than applying it to price", () => {
  expect(researchRetracementStop(100, 90, 119.99)).toBeNull();
  for (const [high, stop, giveback] of [
    [120, 114, 0.3],
    [130, 122.5, 0.25],
    [140, 132, 0.2],
    [170, 166.5, 0.05],
    [180, 176, 0.05],
  ])
    expect(researchRetracementStop(100, 90, high!)).toMatchObject({
      stop,
      giveback,
    });
  expect(researchRetracementStop(100, 100, 120)).toBeNull();
  expect(researchRetracementStop(100, 90, NaN)).toBeNull();
});
it("binds the optional retracement version without changing fixed management", () => {
  const management = researchManagementSchema.parse({
    trail: { kind: "retracement" },
  });
  expect(
    researchMethodSnapshot({ strategy: "dual-breakout", management }),
  ).toHaveProperty("retracement.version", "research-retracement-1");
  expect(
    researchMethodSnapshot({
      strategy: "dual-breakout",
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("retracement");
});
