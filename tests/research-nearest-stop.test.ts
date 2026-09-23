import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import type { ResearchEvent } from "../src/lib/strategy-research";
import { expect, it } from "vitest";
import {
  researchInitialStop,
  researchStopComparison,
  researchManagementSchema,
} from "../src/lib/research-management";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { selectResearchStrategy } from "../src/components/research/research-strategy-fields";
import { researchMethodSnapshot } from "../src/server/research/research-method";
const management = researchManagementSchema.parse({
  stop: {
    kind: "nearest-stop",
    fraction: 0.05,
    period: 14,
    multiple: 1.5,
    structureBuffer: 0.3,
  },
});
it("selects the nearest valid long stop, preserving all three source candidates", () => {
  const result = researchStopComparison(management.stop, 80, {
    initialStop: 76.5,
    stopAtr: 2.5,
  });
  expect(result).toEqual({
    candidates: [
      { kind: "percent", price: 76 },
      { kind: "atr", price: 76.25 },
      { kind: "structure", price: 75.75 },
    ],
    selected: 76.25,
  });
  expect(
    researchInitialStop(management, 80, { initialStop: 79, stopAtr: 1 }),
  ).toBe(78.7);
  expect(
    researchInitialStop(management, 80, { initialStop: 79, stopAtr: 10 }),
  ).toBe(76);
  const equal = researchManagementSchema.parse({
    stop: {
      kind: "nearest-stop",
      fraction: 0.05,
      period: 14,
      multiple: 2,
      structureBuffer: 0,
    },
  });
  expect(researchInitialStop(equal, 80, { initialStop: 76, stopAtr: 2 })).toBe(
    76,
  );
});
it("rejects any missing or invalid candidate instead of silently comparing a smaller set", () => {
  for (const evidence of [
    {},
    { initialStop: 76.5 },
    { stopAtr: 2.5 },
    { initialStop: 76.5, stopAtr: 0 },
    { initialStop: 76.5, stopAtr: NaN },
    { initialStop: 0.1, stopAtr: 2.5 },
    { initialStop: 81, stopAtr: 1 },
    { initialStop: 76.5, stopAtr: 100 },
  ])
    expect(researchInitialStop(management, 80, evidence)).toBeNull();
  for (const entry of [0, Infinity, NaN])
    expect(
      researchInitialStop(management, entry, {
        initialStop: 76.5,
        stopAtr: 2.5,
      }),
    ).toBeNull();
});
it("versions the complete comparison and clears unsupported structure configuration", () => {
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: "2024-01-01",
    end: "2024-12-31",
    validationStart: "2024-10-01",
    risk: { fraction: 0.01, maxWeight: 0.2 },
    management,
  });
  expect(
    researchSpecSchema.safeParse({ ...spec, strategy: "ma-cross" }).success,
  ).toBe(false);
  expect(selectResearchStrategy(spec, "ma-cross").management!.stop).toEqual({
    kind: "percent",
    fraction: 0.05,
  });
  const method = researchMethodSnapshot(spec);
  expect(method).toHaveProperty(
    "nearestStop.version",
    "research-nearest-stop-1",
  );
  expect(method.sources.some((s) => s.path === "stop-loss/SKILL.md")).toBe(
    true,
  );
  expect(
    researchMethodSnapshot({
      ...spec,
      management: researchManagementSchema.parse({}),
    }),
  ).not.toHaveProperty("nearestStop");
  expect(
    researchManagementSchema.safeParse({
      stop: { ...management.stop, multiple: 0 },
    }).success,
  ).toBe(false);
});

it("exits on the nearest close-confirmed line while the farther comparison remains open", () => {
  const dates = Array.from({ length: 6 }, (_, i) => `2024-01-0${i + 1}`);
  const prices = [80, 80, 77, 77, 77, 77];
  const bars = dates.map((date, i) => ({
    date,
    open: i === 3 ? 75 : 80,
    close: prices[i]!,
    high: 81,
    low: i === 1 ? 74 : 74,
    volume: 10000,
    amount: 1000000,
  }));
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: dates[0]!,
    endpointDate: dates[0]!,
    key: "fixture",
    strategyVersion: "fixture",
    evidence: "{}",
    partition: "development",
    initialStop: 79,
    stopAtr: 1,
  };
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: dates[0],
    end: dates[5],
    validationStart: dates[5],
    initialCapital: 100000,
    holdingDays: 60,
    risk: { fraction: 0.01, maxWeight: 1 },
    management,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const run = (kind: "nearest-stop" | "max-distance", confirmations = 1) =>
    researchPortfolio(
      {
        ...spec,
        management: researchManagementSchema.parse({
          ...management,
          confirmations,
          stop: { ...management.stop, kind },
        }),
      },
      [event],
      dates,
      new Map([[event.symbol, bars]]),
      () => ({
        evidence: "fixture",
        minimumBuy: 100,
        buyStep: 100,
        maximumOrder: 100000,
        tradable: true,
        limitUp: null,
        limitDown: null,
      }),
    ).trades[0]!;
  const close = run("nearest-stop");
  expect(close.initialStop).toBe(78.7);
  expect(close.quantity).toBe(700);
  expect(close.exitDate).toBe(dates[3]);
  expect(close.exitPrice).toBe(75);
  expect(close.profit).toBe(-3500);
  // Entry-day low pierced every line: it is not an intraday stop trigger.
  expect(run("max-distance").exitDate).toBeNull();
  expect(run("nearest-stop", 2).exitDate).toBe(dates[4]);
});
