import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  createTheoryRangeRule,
  createTheorySupportRejection,
  createTheoryFailedUpthrust,
  theoryFrozenRanges,
  theoryRangeIds,
} from "../src/theory-range";

const empty = { entry: 0, entryIndex: 0 };
function flat(n = 130): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
}
function set(b: Bar[], i: number, change: Partial<Bar>) {
  b[i] = { ...b[i]!, ...change };
}
function range() {
  const b = flat();
  set(b, 20, { low: 90 });
  set(b, 30, { high: 110 });
  set(b, 40, { low: 90 });
  set(b, 50, { high: 110 });
  return b;
}
function reversion() {
  const b = range();
  set(b, 61, { open: 92, low: 90, close: 93, high: 95 });
  set(b, 62, { open: 93, low: 92, close: 96, high: 97 });
  return b;
}
function sos() {
  const b = range();
  set(b, 60, { low: 95 });
  set(b, 65, { open: 111, low: 111, high: 118, close: 117, volume: 3000 });
  for (let i = 66; i <= 71; i++)
    set(b, i, { open: 113, low: 112, high: 114, close: 113, volume: 500 });
  set(b, 68, { low: 110.5 });
  set(b, 72, { open: 113, low: 112, high: 116, close: 115, volume: 700 });
  return b;
}

describe("frozen range components and local strategies", () => {
  it("freezes only alternating confirmed extrema, never updates the active boundaries", () => {
    const b = range();
    const ranges = theoryFrozenRanges(b);
    expect(ranges[58]).toBeNull();
    expect(ranges[59]).toMatchObject({
      lower: 90,
      upper: 110,
      formedAt: 59,
      expiresAt: 79,
    });
    expect(ranges[79]).toEqual(ranges[59]);
    expect(ranges[80]).toBeNull();
    set(b, 40, { low: 95 });
    expect(theoryFrozenRanges(b)[59]).toBeNull();
  });
  it("support waits for right confirmation, freezes ATR tolerance, rejects deep pierces", () => {
    const b = flat();
    set(b, 50, { low: 90 });
    set(b, 54, { open: 92, low: 90, close: 92, high: 93 });
    const rule = createTheorySupportRejection(b);
    expect(rule(52).status).toBe("wait");
    expect(rule(54)).toMatchObject({
      status: "signal",
      level: 90,
      confirmedAt: 53,
    });
    set(b, 54, { low: 85 });
    expect(createTheorySupportRejection(b)(54).status).toBe("wait");
    set(b, 54, { close: 85, open: 85, low: 84 });
    expect(createTheorySupportRejection(b)(54).status).toBe("invalid");
  });
  it("enters after rejection, uses actual signal index despite delayed fill, exits at frozen middle", () => {
    const b = reversion();
    const rule = createTheoryRangeRule("theory-range-reversion", b)!;
    expect(rule(61, empty).enter).toBe(false);
    expect(rule(62, empty).enter).toBe(true);
    const position = { entry: 96, entryIndex: 65, signalIndex: 62 };
    expect(rule(65, position)).toEqual({ enter: false, exit: true });
    expect(rule(65, empty).exit).toBe(false);
    expect(rule(62, empty).enter).toBe(true);
    expect(rule(62, { entry: 95, entryIndex: 61 }).enter).toBe(false);
  });
  it("rejection expiry, broken low, invalid range and missing OHLC prevent entry", () => {
    const b = reversion();
    set(b, 62, { low: 89 });
    expect(
      createTheoryRangeRule("theory-range-reversion", b)!(62, empty).enter,
    ).toBe(false);
    set(b, 62, { close: 89, open: 89, low: 88 });
    expect(
      createTheoryRangeRule("theory-range-reversion", b)!(62, empty).enter,
    ).toBe(false);
    set(b, 62, { close: Number.NaN });
    expect(
      createTheoryRangeRule("theory-range-reversion", b)!(62, empty),
    ).toEqual({ enter: false, exit: false });
    const expired = reversion();
    for (let i = 62; i <= 66; i++)
      set(expired, i, { open: 93, low: 92, close: 93, high: 94 });
    set(expired, 67, { open: 93, low: 92, close: 96, high: 97 });
    expect(
      createTheoryRangeRule("theory-range-reversion", expired)!(67, empty)
        .enter,
    ).toBe(false);
  });
  it("requires a separate confirmed lower rebound before an upthrust exit signal", () => {
    const b = range();
    set(b, 61, { open: 110, close: 112, high: 113, low: 109 });
    set(b, 62, { open: 108, close: 108, high: 110, low: 107 });
    for (let i = 63; i <= 69; i++)
      set(b, i, { open: 107, close: 107, high: 109, low: 105 });
    set(b, 66, { high: 112 });
    set(b, 70, { open: 104, close: 104, high: 106, low: 103 });
    const component = createTheoryFailedUpthrust(b);
    expect(component(69).status).toBe("wait");
    expect(component(70)).toMatchObject({
      status: "signal",
      level: 105,
      confirmedAt: 69,
    });
    expect(component(71).status).toBe("wait");
    set(b, 66, { high: 114 });
    expect(createTheoryFailedUpthrust(b)(70).status).toBe("wait");
  });
  it("requires SOS before a low-volume narrow pullback and a later confirmed trigger", () => {
    const b = sos();
    const rule = createTheoryRangeRule("theory-sos-pullback", b)!;
    expect(rule(71, empty).enter).toBe(false);
    expect(rule(72, empty).enter).toBe(true);
    expect(rule(73, { entry: 115, entryIndex: 73, signalIndex: 72 }).exit).toBe(
      true,
    );
    set(b, 65, { volume: 1000 });
    expect(
      createTheoryRangeRule("theory-sos-pullback", b)!(72, empty).enter,
    ).toBe(false);
  });
  it("rejects missing volume, expanding pullback and loss of support", () => {
    for (const change of [
      { volume: 4000 },
      { volume: Number.NaN },
      { low: 109 },
    ]) {
      const b = sos();
      for (let i = 66; i <= 71; i++) set(b, i, change);
      expect(
        createTheoryRangeRule("theory-sos-pullback", b)!(72, empty).enter,
      ).toBe(false);
    }
  });
  it("holds without re-entry and respects 40-bar actual-fill timeout", () => {
    const b = sos();
    for (let i = 73; i < b.length; i++)
      set(b, i, { open: 115, close: 115, high: 116, low: 114 });
    const rule = createTheoryRangeRule("theory-sos-pullback", b)!;
    const position = { entry: 115, entryIndex: 75, signalIndex: 72 };
    expect(rule(114, position)).toEqual({ enter: false, exit: false });
    expect(rule(115, position)).toEqual({ enter: false, exit: true });
  });
  it("is prefix causal and repeatable in reverse evaluation order", () => {
    for (const b of [reversion(), sos()]) {
      for (const id of theoryRangeIds) {
        const full = createTheoryRangeRule(id, b)!;
        for (let i = 85; i >= 55; i--) {
          expect(full(i, empty)).toEqual(
            createTheoryRangeRule(id, b.slice(0, i + 1))!(i, empty),
          );
          const position = { entry: 100, entryIndex: 75, signalIndex: 72 };
          expect(full(i, position)).toEqual(
            createTheoryRangeRule(id, b.slice(0, i + 1))!(i, position),
          );
        }
      }
      for (let i = 85; i >= 55; i--) {
        expect(createTheorySupportRejection(b)(i)).toEqual(
          createTheorySupportRejection(b.slice(0, i + 1))(i),
        );
        expect(createTheoryFailedUpthrust(b)(i)).toEqual(
          createTheoryFailedUpthrust(b.slice(0, i + 1))(i),
        );
      }
    }
  });
  it("retains an unfilled rejection but requires a fresh rejection after actual exit", () => {
    const b = reversion();
    set(b, 65, { open: 92, close: 93, high: 95, low: 90 });
    set(b, 66, { open: 93, close: 96, high: 97, low: 92 });
    const rule = createTheoryRangeRule("theory-range-reversion", b)!;
    expect(rule(62, empty).enter).toBe(true);
    expect(rule(63, empty)).toEqual({ enter: true, exit: false });
    expect(rule(63, { entry: 96, entryIndex: 63, signalIndex: 62 }).exit).toBe(
      true,
    );
    expect(rule(64, { ...empty, lastExitIndex: 63 }).enter).toBe(false);
    expect(rule(66, { ...empty, lastExitIndex: 63 }).enter).toBe(true);
    expect(rule(66, { entry: 96, entryIndex: 63, signalIndex: 62 }).enter).toBe(
      false,
    );
  });
  it("retains SOS candidates after rejected buys and never reuses a pre-exit setup", () => {
    const b = sos();
    for (let i = 73; i <= 76; i++)
      set(b, i, { open: 115, close: 115, high: 116, low: 114 });
    const rule = createTheoryRangeRule("theory-sos-pullback", b)!;
    expect(rule(74, empty).enter).toBe(true);
    expect(rule(72, empty).enter).toBe(true);
    expect(
      rule(73, { entry: 115, entryIndex: 73, signalIndex: 72 }).enter,
    ).toBe(false);
    expect(rule(75, { ...empty, lastExitIndex: 74 }).enter).toBe(false);
    expect(rule(74, empty).enter).toBe(true);
    expect(() => rule(75, { ...empty, lastExitIndex: 76 })).toThrow(
      "exit index",
    );
  });
  it("keeps the signal-origin stop on delayed fills and repeats blocked exits", () => {
    const b = sos();
    for (let i = 73; i < 80; i++)
      set(b, i, { open: 112, close: 112, high: 113, low: 111 });
    set(b, 76, { open: 110, close: 110, high: 111, low: 109 });
    set(b, 77, { open: 110, close: 110, high: 111, low: 109 });
    const rule = createTheoryRangeRule("theory-sos-pullback", b)!;
    const position = { entry: 112, entryIndex: 75, signalIndex: 72 };
    expect(rule(76, position).exit).toBe(true);
    expect(rule(77, position).exit).toBe(true);
    expect(rule(76, { entry: 112, entryIndex: 75 }).exit).toBe(false);
    expect(rule(76, empty).exit).toBe(false);
  });
  it("cancels a pullback trigger after five completed bars and never refreshes its deadline", () => {
    const b = sos();
    for (let i = 72; i <= 76; i++)
      set(b, i, { open: 113, close: 113, high: 114, low: 112 });
    set(b, 77, { open: 113, close: 115, high: 116, low: 112 });
    expect(
      createTheoryRangeRule("theory-sos-pullback", b)!(77, empty).enter,
    ).toBe(false);
  });
  it("does not infer the order of an intrabar breach and reclaim", () => {
    const b = range();
    set(b, 61, { high: 112, close: 108, open: 108 });
    expect(createTheoryFailedUpthrust(b)(61).status).toBe("unknown");
  });
});
