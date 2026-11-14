import { describe, expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import {
  researchWyckoffSeries as series,
  wyckoffIds,
} from "trading-strategies/research/wyckoff/research-wyckoff";
import { structureEventMachine } from "trading-strategies/research/technical/research-structure-events";

function fixture(): Bar[] {
  const anchors = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
  ];
  return Array.from({ length: 90 }, (_, i) => {
    const r = anchors.findIndex((a) => a[0]! >= i),
      a = anchors[Math.max(0, r - 1)]!,
      b = anchors[r]!;
    const close =
      a[1]! + ((b[1]! - a[1]!) * (i - a[0]!)) / Math.max(1, b[0]! - a[0]!);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.1,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: 100,
      amount: close * 100,
    };
  });
}
function append(bars: Bar[], row: Partial<Bar>) {
  const i = bars.length;
  bars.push({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 105,
    close: 105.2,
    high: 105.5,
    low: 104.5,
    volume: 100,
    amount: 10500,
    ...row,
  });
  return bars;
}
function jac() {
  const bars = fixture();
  append(bars, { open: 102, low: 102, high: 106, close: 105.5, volume: 150 });
  append(bars, { open: 105.2, low: 104.5, high: 105.8, close: 105.6 });
  return bars;
}
it("records immutable candidate and subsequent confirmation separately; duplicate keys do not rearm", () => {
  const m = structureEventMachine<{ level: number }>();
  const seed = { key: "a", kind: "spring", facts: { level: 10 } };
  const a = m.observe("2020-01-01", [seed], () => ({
    state: "confirmed",
    reason: "confirmed",
  }));
  seed.facts.level = 999;
  expect(a[0]).toMatchObject({
    state: "candidate",
    confirmedAt: null,
    facts: { level: 10 },
  });
  const b = m.observe("2020-01-02", [seed], () => ({
    state: "confirmed",
    reason: "confirmed",
  }));
  expect(b).toHaveLength(1);
  expect(b[0]).toMatchObject({
    candidateAt: "2020-01-01",
    confirmedAt: "2020-01-02",
    facts: { level: 10 },
  });
  expect(a[0]!.confirmedAt).toBeNull();
  expect(
    m.observe("2020-01-03", [seed], () => ({
      state: "confirmed",
      reason: "confirmed",
    })),
  ).toEqual([]);
  expect(() =>
    m.observe("2020-01-03", [], () => ({ state: "waiting", reason: "" })),
  ).toThrow("严格递增");
});
it("unavailable input cancels rather than confirms a waiting event", () => {
  const m = structureEventMachine<number>();
  m.observe("1", [{ key: "x", kind: "spring", facts: 1 }], () => ({
    state: "waiting",
    reason: "",
  }));
  expect(
    m.observe("2", [], () => ({ state: "confirmed", reason: "" }), "缺日")[0],
  ).toMatchObject({ state: "cancelled", confirmedAt: null, reason: "缺日" });
});
it("WY02 JAC waits for next close and uses inclusive 1.5 volume threshold", () => {
  const bars = jac(),
    rows = series("wy-sos-jac-daily", bars);
  expect(rows[90]).toMatchObject({
    entry: false,
    structure: { support: 95.5, resistance: 104.5 },
  });
  expect(rows[90]!.events).toContainEqual(
    expect.objectContaining({
      kind: "jac",
      state: "candidate",
      confirmedAt: null,
    }),
  );
  expect(rows[91]!.entry).toBe(true);
  expect(rows[91]!.events).toContainEqual(
    expect.objectContaining({
      kind: "jac",
      candidateAt: bars[90]!.date,
      confirmedAt: bars[91]!.date,
    }),
  );
  bars[90]!.volume = 149.99;
  expect(series("wy-sos-jac-daily", bars)[91]!.entry).toBe(false);
});
it("WY01 Spring retains frozen support, requires recovery volume and cancels a new low", () => {
  const bars = fixture();
  append(bars, { open: 96, low: 94, high: 97, close: 96, volume: 100 });
  append(bars, { open: 96, low: 94, high: 98, close: 97, volume: 150 });
  expect(series("wy-spring-daily", bars).at(-1)!.entry).toBe(true);
  bars[91]!.volume = 149;
  expect(series("wy-spring-daily", bars).at(-1)!.entry).toBe(false);
  bars[91]!.volume = 150;
  bars[91]!.low = 93.99;
  expect(series("wy-spring-daily", bars).at(-1)!.events).toContainEqual(
    expect.objectContaining({ kind: "spring", state: "cancelled" }),
  );
});
it("WY03/WY04 require a confirmed advance, contracted shallow retest and a later rebound", () => {
  const bars = jac();
  append(bars, {
    open: 105.5,
    close: 105,
    high: 105.6,
    low: 104.5,
    volume: 40,
  });
  append(bars, {
    open: 105.1,
    close: 105.8,
    high: 106,
    low: 104.8,
    volume: 100,
  });
  for (const id of ["wy-lps-daily", "wy-reaccumulation-daily"] as const) {
    const rows = series(id, bars);
    expect(rows[92]!.entry).toBe(false);
    expect(rows[93]!.entry).toBe(true);
    expect(rows[93]!.events).toContainEqual(
      expect.objectContaining({
        kind: "lps",
        state: "confirmed",
        facts: expect.objectContaining({ parentAt: bars[90]!.date }),
      }),
    );
  }
  bars[92]!.volume = 60;
  expect(series("wy-lps-daily", bars)[93]!.entry).toBe(false);
});
it("WY05 UT waits for failed recovery and exits existing longs only", () => {
  const bars = fixture();
  append(bars, { open: 104, high: 106, low: 103, close: 104, volume: 100 });
  append(bars, { open: 104, high: 105.5, low: 102, close: 103, volume: 150 });
  const p = series("wy-ut-exit-daily", bars).at(-1)!;
  expect(p).toMatchObject({ entry: false, exit: true });
  expect(p.events).toContainEqual(
    expect.objectContaining({ kind: "ut", state: "confirmed" }),
  );
  bars[91]!.high = 106.01;
  expect(series("wy-ut-exit-daily", bars).at(-1)!.events).toContainEqual(
    expect.objectContaining({ kind: "ut", state: "cancelled" }),
  );
});
it("WY07 breaks ice at completed close, never creates a short entry", () => {
  const bars = fixture();
  append(bars, { open: 99, high: 99, low: 93, close: 94, volume: 150 });
  expect(series("wy-ice-exit-daily", bars).at(-1)).toMatchObject({
    exit: true,
    entry: false,
    events: expect.arrayContaining([
      expect.objectContaining({
        kind: "ice",
        state: "confirmed",
        confirmedAt: bars[90]!.date,
      }),
    ]),
  });
  bars[90]!.close = 95.5;
  expect(
    series("wy-ice-exit-daily", bars)
      .at(-1)!
      .events.some((e) => e.kind === "ice"),
  ).toBe(false);
});
it("WY06 confirms SOW before LPSY and reduces half only after the rebound fails", () => {
  const bars = fixture();
  append(bars, { open: 102, high: 102, low: 98, close: 99, volume: 150 });
  append(bars, { open: 99, high: 100, low: 98.5, close: 99, volume: 100 });
  append(bars, { open: 99.2, high: 100, low: 99, close: 99.5, volume: 40 });
  append(bars, { open: 99, high: 99.8, low: 98, close: 98.5, volume: 100 });
  const rows = series("wy-sow-lpsy-daily", bars);
  expect(rows[92]!.reduction).toBeUndefined();
  expect(rows[93]).toMatchObject({
    entry: false,
    reduction: { fraction: 0.5 },
  });
  bars[92]!.high = 100.01;
  expect(series("wy-sow-lpsy-daily", bars)[93]!.reduction).toBeUndefined();
});
it("WY08 no-TR pullback confirms next bar and is not a standard Wyckoff entry", () => {
  const bars = Array.from({ length: 90 }, (_, i) => ({
    ...fixture()[i]!,
    open: 100 + i * 0.2 - 0.1,
    close: 100 + i * 0.2,
    high: 100 + i * 0.2 + 0.5,
    low: 100 + i * 0.2 - 0.5,
  }));
  const avg = bars.slice(-20).reduce((s, b) => s + b.close, 0) / 20;
  append(bars, {
    open: 117,
    low: avg,
    high: 117.2,
    close: avg + 0.3,
    volume: 40,
  });
  append(bars, {
    open: 117,
    low: avg + 0.1,
    high: 118,
    close: 117.5,
    volume: 150,
  });
  expect(series("wy-trend-pullback-daily", bars).at(-1)).toMatchObject({
    structure: null,
    entry: true,
  });
  bars[91]!.close = 117.2;
  expect(series("wy-trend-pullback-daily", bars).at(-1)!.entry).toBe(false);
});
describe("pending-state specific barriers", () => {
  it("missing scheduled confirmation day cancels the frozen candidate", () => {
    const bars = jac();
    const calendar = bars.map((b) => b.date);
    calendar.splice(91, 0, "2020-03-31-extra");
    const p = series("wy-sos-jac-daily", bars, calendar).at(-1)!;
    expect(p.entry).toBe(false);
    expect(p.events).toContainEqual(
      expect.objectContaining({ kind: "jac", state: "cancelled" }),
    );
  });
  it("every profile returns no pending confirmations through invalid history", () => {
    const bars = jac();
    bars[70]!.high = 0;
    for (const id of wyckoffIds)
      expect(series(id, bars).at(-1)).toMatchObject({
        entry: false,
        events: [],
      });
  });
});
