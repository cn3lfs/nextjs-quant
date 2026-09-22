import { expect, it } from "vitest";
import { rollingHigh } from "../src/lib/indicators";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
const dates = Array.from(
  { length: 7 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const bars = [110, 105, 104, 103, 102, 101, 100].map((high, i) => ({
  date: dates[i]!,
  open: 100,
  close: 100,
  high,
  low: 99,
  volume: 10000,
  amount: 1000000,
}));
it("uses only complete windows and drops the old peak without forward access", () => {
  expect(rollingHigh(bars, 3)).toEqual([null, null, 110, 105, 104, 103, 102]);
  expect(rollingHigh(bars.slice(0, 4), 3)).toEqual(
    rollingHigh(bars, 3).slice(0, 4),
  );
  expect(
    rollingHigh(
      bars.map((b, i) => (i === 2 ? { ...b, volume: 0 } : b)),
      3,
    ).slice(2, 5),
  ).toEqual([null, null, null]);
  expect(() => rollingHigh(bars, 0)).toThrow();
});
it("never loosens the stop when the rolling high falls, and records its own version", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[6],
    validationStart: dates[6],
    initialCapital: 100000,
    holdingDays: 60,
    risk: { fraction: 0.05, maxWeight: 0.5 },
    management: {
      stop: { kind: "percent", fraction: 0.2 },
      trail: { kind: "rolling-chandelier", period: 3, multiple: 1 },
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
    observedDate: dates[1]!,
    endpointDate: dates[1]!,
    key: "fixture",
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
  };
  const input = bars.map((b, i) => ({
    ...b,
    open: 120,
    close: 120,
    high: i === 3 ? 150 : 130,
    low: 90,
  }));
  const run = (selected = spec, data = input) =>
    researchPortfolio(
      selected,
      [event],
      dates,
      new Map([[event.symbol, data]]),
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
  const result = run();
  const history = result.trades[0]!.stopHistory!;
  expect(history[0]!.stop).toBe(96);
  expect(
    history.every((r, i) => i === 0 || r.stop > history[i - 1]!.stop),
  ).toBe(true);
  expect(history).toHaveLength(2);
  expect(history[1]!.date).toBe(dates[3]);
  expect(history[1]!.stop).toBeCloseTo(150 - 140 / 3);
  expect(rollingHigh(input, 3)[6]).toBe(130);
  expect(result.trades[0]!.exitDate).toBeNull();
  const legacy = researchSpecSchema.parse({
    ...spec,
    management: {
      ...spec.management,
      trail: { kind: "chandelier", period: 3, multiple: 1 },
    },
  });
  expect(run(legacy).trades[0]!.stopHistory!.at(-1)!.stop).toBe(110);
  expect(researchMethodSnapshot(legacy)).not.toHaveProperty(
    "rollingChandelier",
  );
  const invalid = run(
    spec,
    input.map((b, i) => (i === 5 ? { ...b, volume: 0 } : b)),
  ).trades[0]!;
  expect(invalid.stopHistory).toEqual(history);
  expect(
    invalid.managementWarnings!.some(
      (w) => w.date === dates[6] && w.reason.includes("窗口最高价"),
    ),
  ).toBe(true);
  const preEntryHigh = input.map((b, i) => ({
    ...b,
    high: i === 1 ? 150 : 130,
  }));
  expect(
    run(spec, preEntryHigh).trades[0]!.stopHistory!.at(-1)!.stop,
  ).toBeCloseTo(150 - 140 / 3);
  expect(run(legacy, preEntryHigh).trades[0]!.stopHistory!.at(-1)!.stop).toBe(
    96,
  );
  expect(researchMethodSnapshot(spec)).toHaveProperty(
    "rollingChandelier.version",
    "research-rolling-chandelier-1",
  );
});
