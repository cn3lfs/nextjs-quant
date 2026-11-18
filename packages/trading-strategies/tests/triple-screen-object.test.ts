import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  prepareStrategy,
  strategyObjectSchema,
  type StrategyObjectInput,
} from "../src/strategy-object.js";
import type {
  TripleScreenInput,
  TripleScreenSeries,
} from "../src/theory-multiperiod.js";

const stamp = (i: number) =>
  new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString();
const bar = (date: string, close: number): Bar => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: close * 100,
});
function series(
  period: TripleScreenSeries["period"],
  values: number[],
  offset = 0,
): TripleScreenSeries {
  return {
    period,
    sourceHash: "fixture",
    adjustmentId: "raw",
    calendarHash: "calendar",
    slots: values.map((v, i) => ({
      availableAt: stamp(i + offset + (period === "day" ? 1 : 0)),
      priceScale: 1,
      bar: bar(
        period === "day" ? stamp(i + offset).slice(0, 10) : stamp(i + offset),
        v,
      ),
    })),
  };
}
function fixture(): TripleScreenInput {
  return {
    variant: "day-hour-five",
    market: "crypto",
    tick: 0.01,
    background: series(
      "day",
      Array.from({ length: 40 }, (_, i) => 100 + i * i),
    ),
    setup: series("60m", [20, 19, 18], 37),
    execution: series("5m", [18, 20, 21, 16, 22], 39),
  };
}
function strategy(input: TripleScreenInput): StrategyObjectInput {
  return {
    id: "triple-object",
    version: 1,
    market: input.market,
    period: input.variant === "week-day" ? "day" : "5m",
    universe: {
      kind: "symbols",
      symbols: input.market === "crypto" ? ["BTCUSDT"] : ["sh600000"],
    },
    entry: { kind: "triple-screen", variant: input.variant, side: "entry" },
    exit: {
      rule: { kind: "triple-screen", variant: input.variant, side: "exit" },
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  };
}
function bars(input: TripleScreenInput) {
  return input.execution.slots.flatMap((slot) => (slot.bar ? [slot.bar] : []));
}
function prepare(input: TripleScreenInput) {
  return prepareStrategy(strategy(input), bars(input), { tripleScreen: input });
}

describe("triple screen strategy object boundary", () => {
  it("bridges actual signal and fill indices across missing execution slots", () => {
    const input = fixture();
    input.execution.slots = [
      ...input.execution.slots.slice(0, 2),
      { availableAt: stamp(40.5), bar: null, reason: "missing" },
      ...input.execution.slots.slice(2),
    ];
    const rule = prepare(input);
    expect(rule.evaluate(1).entry).toBe(true);
    const held = { entry: 21, entryIndex: 2, signalIndex: 1 };
    expect(rule.evaluate(2, held)).toMatchObject({ entry: false, exit: false });
    expect(rule.evaluate(3, held)).toMatchObject({ entry: false, exit: true });
    expect(
      rule.evaluate(4, { entry: 0, entryIndex: 4, lastExitIndex: 3 }).entry,
    ).toBe(false);
  });
  it("retains missing-slot invalidation for flat accounts instead of compressing the clock", () => {
    const input = fixture();
    input.execution.slots = [
      input.execution.slots[0]!,
      { availableAt: stamp(39.5), bar: null },
      ...input.execution.slots.slice(1),
    ];
    expect(prepare(input).evaluate(1).entry).toBe(false);
  });
  it("rejects forged future execution availability even when all OHLCV fields match", () => {
    const input = fixture();
    input.execution.slots = input.execution.slots.map((slot) => ({
      ...slot,
      availableAt: new Date(
        Date.parse(slot.availableAt) + 3600000,
      ).toISOString(),
    }));
    expect(() => prepare(input)).toThrow();
  });
  it("accepts daily market close clocks and rejects a later invented execution clock", () => {
    for (const market of ["cn-equity", "crypto"] as const) {
      const input = fixture();
      input.variant = "week-day";
      input.market = market;
      input.background.period = "week";
      input.background.slots = [];
      input.setup.period = "day";
      input.execution.period = "day";
      input.execution.slots = input.execution.slots.map((slot) => ({
        ...slot,
        bar: { ...slot.bar!, date: slot.bar!.date.slice(0, 10) },
        availableAt: new Date(
          Date.parse(slot.bar!.date) +
            (market === "cn-equity" ? 7 : 24) * 3600000,
        ).toISOString(),
      }));
      input.setup.slots = input.execution.slots;
      expect(() => prepare(input)).not.toThrow();
      input.execution.slots = input.execution.slots.map((slot) => ({
        ...slot,
        availableAt: new Date(
          Date.parse(slot.availableAt) + 3600000,
        ).toISOString(),
      }));
      expect(() => prepare(input)).toThrow();
    }
  });
  it("rejects swapped entry/exit sides and incompatible variants", () => {
    const object = strategy(fixture());
    expect(() =>
      strategyObjectSchema.parse({
        ...object,
        entry: { ...object.entry, side: "exit" },
      }),
    ).toThrow();
    expect(() =>
      strategyObjectSchema.parse({
        ...object,
        exit: { rule: { ...object.exit.rule, side: "entry" } },
      }),
    ).toThrow();
    expect(() =>
      strategyObjectSchema.parse({
        ...object,
        exit: {
          rule: { kind: "triple-screen", variant: "week-day", side: "exit" },
        },
      }),
    ).toThrow();
  });
  it("rejects market mismatch and modified execution prices", () => {
    const input = fixture();
    expect(() =>
      prepareStrategy(
        {
          ...strategy(input),
          market: "cn-equity",
          universe: { kind: "symbols", symbols: ["sh600000"] },
        },
        bars(input),
        { tripleScreen: input },
      ),
    ).toThrow();
    const changed = bars(input).map((b, i) =>
      i === 1 ? { ...b, close: b.close + 0.5 } : b,
    );
    expect(() =>
      prepareStrategy(strategy(input), changed, { tripleScreen: input }),
    ).toThrow();
  });
  it("preserves prefix causality and repeatability through the object bridge", () => {
    const input = fixture();
    const full = prepare(input);
    for (let i = bars(input).length - 1; i >= 0; i--) {
      const prefix = {
        ...input,
        execution: {
          ...input.execution,
          slots: input.execution.slots.slice(0, i + 1),
        },
      };
      expect(full.evaluate(i)).toEqual(prepare(prefix).evaluate(i));
      expect(full.evaluate(i)).toEqual(full.evaluate(i));
    }
  });
});
