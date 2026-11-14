import { expect, it, vi } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import {
  researchVolumeFailureSeries as series,
  volumeFailureIds,
} from "trading-strategies/research/volume/research-volume-failure";
import { researchMethodSnapshot } from "../../../../src/server/research/research-method";

const native = vi.fn(async () => {
  throw new Error("no CZSC");
});
function fixture(): Bar[] {
  return Array.from({ length: 99 }, (_, i) => {
    const close = i < 90 ? 100 + i * 0.2 : i === 90 ? 121 : 119,
      volume = i === 90 ? 300 : 100;
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume,
      amount: close * volume,
    };
  });
}
function breakAt(at: number) {
  const bars = fixture();
  Object.assign(bars[at]!, {
    open: 119,
    close: 118.1,
    high: 119.5,
    low: 117.9,
  });
  return bars;
}
function shape(wick: boolean) {
  const bars = fixture();
  Object.assign(
    bars[91]!,
    wick
      ? { open: 121, close: 121.2, high: 123, low: 120.8, volume: 350 }
      : { open: 122, close: 121, high: 122.5, low: 120.5, volume: 350 },
  );
  return bars;
}
it("counts false-break windows from the signal, including the last allowed bar", () => {
  for (const [id, window] of [
    ["vp-failure-1", 1],
    ["vp-failure-2", 2],
    ["vp-failure-3", 3],
  ] as const) {
    const at = 90 + window,
      rows = series(id, breakAt(at));
    expect(rows[90]!.entry).toBe(true);
    expect(rows[90]!.ruleStop?.days).toBe(0);
    expect(rows[at]!.failure.active[0]!.age).toBe(window);
    expect(rows[at]!.failure.triggered).toEqual([rows[90]!.date]);
    expect(rows[at]!.exit).toBe(true);
    const expired = series(id, breakAt(at + 1));
    expect(expired[at + 1]!.failure.triggered).toEqual([]);
    expect(expired[at + 1]!.exit).toBe(false);
  }
});
it("uses the exact upper-wick boundary and only the next bar", () => {
  const bars = shape(true);
  Object.assign(bars[91]!, { open: 121, close: 121.2, high: 122, low: 120.4 });
  expect(
    series("vp-next-wick-exit", bars)[91]!.failure.upperWickFraction,
  ).toBeCloseTo(0.5);
  expect(series("vp-next-wick-exit", bars)[91]!.exit).toBe(true);
  bars[91]!.high = 121.99;
  expect(series("vp-next-wick-exit", bars)[91]!.exit).toBe(false);
  const late = fixture();
  Object.assign(late[92]!, {
    open: 122,
    close: 121,
    high: 122.5,
    low: 120.5,
    volume: 350,
  });
  expect(series("vp-next-shape-exit", late)[92]!.failure.triggered).toEqual([]);
});
it.each(volumeFailureIds)(
  "%s preserves causal prefixes and method source identity",
  (id) => {
    const bars = id.startsWith("vp-failure")
        ? breakAt(92)
        : shape(id === "vp-next-wick-exit"),
      full = series(id, bars);
    for (let n = 89; n <= bars.length; n++)
      expect(series(id, bars.slice(0, n))).toEqual(full.slice(0, n));
    const invalid = bars.map((b, i) => (i === 91 ? { ...b, volume: 0 } : b));
    expect(series(id, invalid)[91]!.reason).not.toBeNull();
    expect(series(id, invalid)[92]!.failure.triggered).toEqual([]);
    expect(researchMethodSnapshot(id).sources).toHaveLength(4);
    expect(native).not.toHaveBeenCalled();
  },
);

it("freezes every overlapping signal separately instead of replacing the earlier line", () => {
  const bars = fixture();
  Object.assign(bars[91]!, { open: 120, close: 120, high: 120.5, low: 119.5 });
  Object.assign(bars[92]!, {
    open: 124,
    close: 124,
    high: 124.5,
    low: 123.5,
    volume: 350,
  });
  Object.assign(bars[93]!, { open: 122, close: 121, high: 122.5, low: 120.5 });
  const rows = series("vp-failure-3", bars);
  expect(rows[92]!.entry).toBe(true);
  expect(rows[93]!.failure.active.map((r) => [r.date, r.level, r.age])).toEqual(
    [
      [bars[90]!.date, 118.3, 3],
      [bars[92]!.date, 121.5, 1],
    ],
  );
  expect(rows[93]!.failure.triggered).toEqual([bars[92]!.date]);
});

it("separates a red candle from a price decline and a long upper wick, with strict larger volume", () => {
  const bear = shape(false),
    wick = shape(true);
  expect(series("vp-next-bear-exit", bear)[91]!.exit).toBe(true);
  expect(series("vp-next-wick-exit", bear)[91]!.exit).toBe(false);
  expect(series("vp-next-bear-exit", wick)[91]!.exit).toBe(false);
  expect(series("vp-next-wick-exit", wick)[91]!.exit).toBe(true);
});
