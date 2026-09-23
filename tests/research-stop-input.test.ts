import { expect, it } from "vitest";
import {
  researchInitialStop,
  researchManagementSchema,
} from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { selectResearchStrategy } from "../src/components/research/research-strategy-fields";
const dates = ["2024-01-02", "2024-01-03", "2024-01-04", "2024-01-05"];
const management = researchManagementSchema.parse({
  stop: {
    kind: "max-distance",
    period: 14,
    multiple: 1.5,
    fraction: 0.05,
    structureBuffer: 0.3,
  },
  stopOverride: { symbol: "sh600000", observedDate: dates[0], price: 95 },
});
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[3],
  validationStart: dates[3],
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
  maximumOrder: 100000,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
function run(config = spec, events = [event]) {
  return researchPortfolio(
    config,
    events,
    dates,
    new Map(
      events.map((e) => [
        e.symbol,
        dates.map((date) => ({
          date,
          open: 100,
          close: 100,
          high: 101,
          low: 99,
          volume: 10000,
          amount: 1000000,
        })),
      ]),
    ),
    () => rules,
  );
}
it("binds absolute override to the signal day and symbol, bypassing missing candidates only for that event", () => {
  const result = run();
  const trade = result.trades[0]!;
  expect(trade.initialStop).toBe(95);
  expect(trade.quantity).toBe(200);
  expect(trade.initialStopOverride).toEqual({ ...management.stopOverride });
  expect(trade.initialStopOverride!.provenance).toBe("manual-scenario");
  expect(trade).not.toHaveProperty("initialStopCandidates");
  for (const different of [
    { symbol: "sh600001", observedDate: dates[0]! },
    { symbol: "sh600000", observedDate: dates[1]! },
  ]) {
    expect(researchInitialStop(management, 100, different)).toBeNull();
    expect(
      researchInitialStop(management, 100, {
        ...different,
        initialStop: 95,
        stopAtr: 2,
      }),
    ).toBe(94.4);
  }
  const other = {
    ...event,
    symbol: "sh600001",
    key: "other",
    initialStop: 95,
    stopAtr: 2,
  };
  const unmatched = run(spec, [event, other]).trades.find(
    (t) => t.event.symbol === other.symbol,
  )!;
  expect(unmatched.initialStop).toBe(94.4);
  expect(unmatched).not.toHaveProperty("initialStopOverride");
  expect(unmatched.initialStopCandidates).toHaveLength(3);
});
it("rejects invalid direction and preserves independent percentage and 2ATR entry gates", () => {
  const wrong = researchSpecSchema.parse({
    ...spec,
    management: {
      ...management,
      stopOverride: { ...management.stopOverride, price: 101 },
    },
  });
  expect(run(wrong).trades).toEqual([]);
  const percentage = researchSpecSchema.parse({
    ...spec,
    management: { ...management, maxInitialStopDistance: 0.02 },
  });
  expect(run(percentage).excluded[0]!.reason).toContain("超过准入上限");
  const gated = researchSpecSchema.parse({
    ...spec,
    management: {
      ...management,
      stop: {
        kind: "structure-atr",
        period: 14,
        multiple: 0.3,
        maxDistanceAtr: 2,
      },
    },
  });
  expect(run(gated).excluded[0]!.reason).toContain("2ATR准入缺少有效");
  expect(run(gated, [{ ...event, stopAtr: 1 }]).trades).toEqual([]);
  const narrow = researchSpecSchema.parse({
    ...gated,
    management: {
      ...gated.management,
      stopOverride: { ...management.stopOverride, price: 99 },
    },
  });
  expect(run(narrow, [{ ...event, stopAtr: 1 }]).trades[0]!.initialStop).toBe(
    99,
  );
});
it("treats unprovided ATR differently from a selected but invalid ATR window", () => {
  const provided = researchManagementSchema.parse({
    stop: {
      kind: "structure-auto",
      atrPeriod: 14,
      atrMultiple: 0.3,
      percentBuffer: 0.005,
    },
  });
  const absent = researchManagementSchema.parse({
    stop: { kind: "structure-auto", atrMultiple: 0.3, percentBuffer: 0.005 },
  });
  expect(
    researchInitialStop(provided, 100, { initialStop: 95, stopAtr: 2 }),
  ).toBe(94.4);
  expect(researchInitialStop(absent, 100, { initialStop: 95 })).toBe(94.525);
  expect(
    researchInitialStop(absent, 100, { initialStop: 95, stopAtr: 200 }),
  ).toBe(94.525);
  for (const stopAtr of [undefined, null, 0, NaN, Infinity])
    expect(
      researchInitialStop(provided, 100, { initialStop: 95, stopAtr }),
    ).toBeNull();
  expect(researchInitialStop(absent, 100, {})).toBeNull();
  expect(researchInitialStop(absent, 90, { initialStop: 95 })).toBeNull();
});
it("validates binding input, versions both modes and preserves legacy shape", () => {
  const method = researchMethodSnapshot(spec);
  expect(method).toHaveProperty(
    "stopOverride.version",
    "research-stop-override-1",
  );
  expect(
    method.sources.some(
      (s) => s.path === "stop-loss/scripts/stop_loss_calc.py",
    ),
  ).toBe(true);
  const auto = researchSpecSchema.parse({
    ...spec,
    management: {
      stop: {
        kind: "structure-auto",
        atrPeriod: 14,
        atrMultiple: 0.3,
        percentBuffer: 0.005,
      },
    },
  });
  expect(researchMethodSnapshot(auto)).toHaveProperty(
    "structureAuto.version",
    "research-structure-auto-1",
  );
  expect(
    researchSpecSchema.safeParse({ ...auto, strategy: "ma-cross" }).success,
  ).toBe(false);
  expect(selectResearchStrategy(auto, "ma-cross").management!.stop.kind).toBe(
    "percent",
  );
  const old = researchManagementSchema.parse({});
  expect(old).not.toHaveProperty("stopOverride");
  expect(
    researchMethodSnapshot({ ...spec, management: old }),
  ).not.toHaveProperty("stopOverride");
  expect(
    researchMethodSnapshot({ ...spec, management: old }),
  ).not.toHaveProperty("structureAuto");
  for (const invalid of [
    { price: 0 },
    { symbol: "600000" },
    { observedDate: "2024-02-30" },
  ])
    expect(
      researchManagementSchema.safeParse({
        ...management,
        stopOverride: { ...management.stopOverride, ...invalid },
      }).success,
    ).toBe(false);
});
