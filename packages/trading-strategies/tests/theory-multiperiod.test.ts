import { describe, expect, it } from "vitest";
import {
  createTripleScreenRule,
  type TripleScreenInput,
  type TripleScreenSeries,
} from "../src/theory-multiperiod.js";
const bar = (date: string, close: number) => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: close * 100,
});
const stamp = (i: number) =>
  new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString();
const series = (
  period: TripleScreenSeries["period"],
  values: number[],
  offset = 0,
): TripleScreenSeries => ({
  period,
  sourceHash: "source",
  adjustmentId: "raw-v1",
  calendarHash: "calendar",
  slots: values.map((v, i) => {
    const time =
      period === "60m"
        ? Date.parse("2020-02-10T08:00:00Z") + (i + offset) * 3600000
        : period === "5m"
          ? Date.parse("2020-02-10T10:00:00Z") + (i + offset) * 300000
          : period === "week"
            ? Date.parse("2019-05-06") + (i + offset) * 7 * 86400000
            : Date.parse(stamp(i + offset));
    const intraday = period === "60m" || period === "5m";
    return {
      priceScale: 1,
      availableAt: new Date(
        time + (intraday ? 0 : period === "week" ? 7 * 86400000 : 86400000),
      ).toISOString(),
      bar: bar(
        intraday
          ? new Date(time).toISOString()
          : new Date(time).toISOString().slice(0, 10),
        v,
      ),
    };
  }),
});
function fixture(): TripleScreenInput {
  return {
    variant: "day-hour-five",
    market: "crypto",
    tick: 0.01,
    background: series(
      "day",
      Array.from({ length: 40 }, (_, i) => 100 + i * i),
    ),
    setup: series("60m", [20, 19, 18]),
    execution: series("5m", [18, 20, 21, 16, 22, 23]),
  };
}
const flat = { entry: 0, entryIndex: 0 };
describe("triple screen completed periods", () => {
  it("does not assume raw prices when execution scale is missing", () => {
    const input = fixture();
    input.execution.slots = input.execution.slots.map(
      ({ priceScale: _scale, ...slot }) => slot,
    );
    expect(() => createTripleScreenRule(input)).toThrow(
      "price scale must be explicit",
    );
  });
  it.each(["background", "setup", "execution"] as const)(
    "rejects premature %s availability",
    (key) => {
      const input = fixture(),
        slots = [...input[key].slots],
        last = slots.at(-1)!;
      slots[slots.length - 1] = {
        ...last,
        availableAt: new Date(Date.parse(last.availableAt) - 1).toISOString(),
      };
      input[key].slots = slots;
      expect(() => createTripleScreenRule(input)).toThrow(
        "Invalid multi-period OHLCV",
      );
    },
  );
  it("reports missing entry evidence separately from a known no-entry result", () => {
    const input = fixture();
    input.tick = null;
    expect(createTripleScreenRule(input)(1, flat)).toMatchObject({
      enter: false,
      entryKnown: false,
      exitKnown: true,
    });
    input.background.slots = input.background.slots.map((slot, i) =>
      i === 37 ? { ...slot, bar: null } : slot,
    );
    expect(createTripleScreenRule(input)(1, flat)).toMatchObject({
      enter: false,
      entryKnown: false,
    });
  });
  it("converts the raw tick into the execution signal price basis", () => {
    const input = fixture();
    input.tick = 1;
    input.execution.slots = input.execution.slots.map((slot) => ({
      ...slot,
      priceScale: 2,
    }));
    // Frozen setup high is 19; raw tick 1 becomes signal increment 2.
    expect(createTripleScreenRule(input)(2, flat).enter).toBe(false);
    input.execution.slots = input.execution.slots.map((slot) => ({
      ...slot,
      priceScale: 1,
    }));
    expect(createTripleScreenRule(input)(2, flat).enter).toBe(true);
  });
  it("uses five subsequent bars for the weekly-daily candidate lifetime", () => {
    const input = fixture();
    input.variant = "week-day";
    input.execution = series(
      "day",
      Array.from({ length: 8 }, () => 20),
      41,
    );
    input.background = series(
      "week",
      Array.from({ length: 40 }, (_, i) => 100 + i * i),
    );
    input.setup = series("day", [20, 19, 18], 39);
    const rule = createTripleScreenRule(input);
    expect(rule(5, flat).enter).toBe(true);
    expect(rule(6, flat)).toMatchObject({
      enter: false,
      reason: "candidate-invalidated",
    });
    expect(rule(7, flat).enter).toBe(false);
  });
  it("uses twelve subsequent bars for the intraday candidate lifetime", () => {
    const input = fixture();
    input.execution = series(
      "5m",
      Array.from({ length: 15 }, () => 20),
      0,
    );
    const rule = createTripleScreenRule(input);
    expect(rule(12, flat).enter).toBe(true);
    expect(rule(13, flat)).toMatchObject({
      enter: false,
      reason: "candidate-invalidated",
    });
    expect(rule(14, flat).enter).toBe(false);
  });
  it("rejects future bars mislabeled as already available", () => {
    const input = fixture();
    input.setup.slots = [{ availableAt: stamp(10), bar: bar(stamp(11), 20) }];
    expect(() => createTripleScreenRule(input)).toThrow(
      "Invalid multi-period OHLCV",
    );
  });
  it("prepares first and triggers only on a subsequent execution close", () => {
    const rule = createTripleScreenRule(fixture());
    expect(rule(0, flat)).toMatchObject({
      enter: false,
      reason: "candidate-created",
      stop: 17,
    });
    expect(rule(1, flat)).toMatchObject({
      enter: true,
      reason: "completed-close-trigger",
      stop: 17,
    });
  });
  it("rejected buys do not consume candidates and calls are order independent", () => {
    const rule = createTripleScreenRule(fixture());
    const second = rule(2, flat),
      first = rule(1, flat);
    expect(first.enter).toBe(true);
    expect(second.enter).toBe(true);
    expect(rule(1, flat)).toEqual(first);
    expect(rule(2, flat)).toEqual(second);
  });
  it("actual fills freeze protection, missing future inputs do not remove it", () => {
    const input = fixture();
    input.background.slots = [
      ...input.background.slots,
      { availableAt: "2020-02-10T10:15:00Z", bar: null, reason: "missing" },
    ];
    const rule = createTripleScreenRule(input),
      position = { entry: 21, entryIndex: 2, signalIndex: 1 };
    expect(rule(2, position)).toMatchObject({
      enter: false,
      exit: false,
      stop: 17,
    });
    expect(rule(3, position)).toMatchObject({
      exit: true,
      exitKnown: true,
      stop: 17,
      reason: "frozen-close-protection",
    });
    expect(rule(3, position)).toEqual(rule(3, position));
  });
  it("actual full exit prevents reusing a pre-exit preparation", () => {
    const rule = createTripleScreenRule(fixture());
    expect(rule(4, { ...flat, lastExitIndex: 3 }).enter).toBe(false);
    expect(rule(5, { ...flat, lastExitIndex: 3 }).setupAt).toBeNull();
  });
  it("future background data cannot alter past outputs", () => {
    const input = fixture(),
      before = createTripleScreenRule(input)(1, flat);
    input.background.slots = [
      ...input.background.slots,
      { availableAt: stamp(101), bar: bar(stamp(100).slice(0, 10), 10) },
    ];
    expect(createTripleScreenRule(input)(1, flat)).toEqual(before);
  });
  it("missing period resets indicator warmup instead of joining across a gap", () => {
    const input = fixture();
    input.background.slots = input.background.slots.map((v, i) =>
      i === 37 ? { ...v, bar: null } : v,
    );
    expect(createTripleScreenRule(input)(1, flat)).toMatchObject({
      enter: false,
      reason: "incomplete-period-or-warmup",
    });
  });
  it("unknown tick blocks entry and mismatched identity is rejected", () => {
    const input = fixture();
    input.tick = null;
    expect(createTripleScreenRule(input)(1, flat)).toMatchObject({
      enter: false,
      reason: "unknown-price-tick",
    });
    input.setup.adjustmentId = "different";
    expect(() => createTripleScreenRule(input)).toThrow(
      "adjustment identities",
    );
  });
  it("does not invent protection without actual entry evidence", () => {
    expect(
      createTripleScreenRule(fixture())(3, { entry: 21, entryIndex: 2 }),
    ).toMatchObject({
      enter: false,
      exit: false,
      reason: "missing-actual-entry-evidence",
    });
  });
});
