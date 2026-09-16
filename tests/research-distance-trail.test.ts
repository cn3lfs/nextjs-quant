import { expect, it } from "vitest";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[3],
  validationStart: dates[3],
  initialCapital: 100000,
  holdingDays: 60,
  risk: { fraction: 0.05, maxWeight: 0.5 },
  management: {
    stop: { kind: "percent", fraction: 0.1 },
    trail: { kind: "distance", distance: 5 },
  },
  costs: {
    commissionBps: 0,
    minimumCommission: 5,
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
const bars = [
  [100, 100, 101],
  [100, 101, 110],
  [106, 104, 109],
  [102, 103, 104],
].map(([open, close, high], i) => ({
  date: dates[i]!,
  open: open!,
  close: close!,
  high: high!,
  low: Math.min(open!, close!) - 1,
  volume: 10000,
  amount: 1000000,
}));
function run(selected = spec, input = bars) {
  return researchPortfolio(
    selected,
    [event],
    input.map((b) => b.date),
    new Map([[event.symbol, input]]),
    () => ({
      evidence: "fixture",
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      tradable: true,
      limitUp: null,
      limitDown: null,
    }),
  );
}
it("keeps a fixed price gap, activates next session and exits at the actual gap including fees", () => {
  const trade = run().trades[0]!;
  expect(trade.stopHistory!.map((r) => [r.date, r.stop])).toEqual([
    [dates[1], 90],
    [dates[1], 105],
  ]);
  expect(trade.exitDate).toBe(dates[3]);
  expect(trade.exitPrice).toBe(102);
  expect(trade.profit).toBe(trade.quantity * 2 - 10);
  const prefix = run(spec, bars.slice(0, 2)).trades[0]!;
  expect(prefix.exitDate).toBeNull();
  expect(prefix.stopHistory).toEqual(trade.stopHistory);
  const percent = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      trail: { kind: "percent", fraction: 0.05 },
    },
  });
  expect(run(percent).trades[0]!.stopHistory![1]!.stop).toBe(104.5);
});
it("preserves the initial stop when a large distance gives a lower candidate", () => {
  const wider = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      trail: { kind: "distance", distance: 200 },
    },
  });
  const trade = run(wider).trades[0]!;
  expect(trade.stopHistory).toHaveLength(1);
  expect(trade.exitDate).toBeNull();
});
it("validates price units and versions only the enabled distance method", () => {
  for (const distance of [0, -1, NaN, Infinity])
    expect(
      researchManagementSchema.safeParse({
        trail: { kind: "distance", distance },
      }).success,
    ).toBe(false);
  expect(
    researchManagementSchema.parse({
      trail: { kind: "distance", distance: 0.01 },
    }).trail,
  ).toEqual({ kind: "distance", distance: 0.01 });
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "distanceTrail.version",
    "research-distance-trail-1",
  );
  expect(
    researchMethodSnapshot({
      strategy: "dual-breakout",
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("distanceTrail");
});
