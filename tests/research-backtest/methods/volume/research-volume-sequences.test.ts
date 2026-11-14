import { type VolumeContextId } from "trading-strategies/research/volume/research-volume-context";
import { expect, it, vi } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { researchVolumeContextSeries } from "trading-strategies/research/volume/research-volume-context";

function fixture(tail: { close: number; volume: number }[]): Bar[] {
  return [
    ...Array.from({ length: 90 }, (_, i) => ({
      close: i >= 86 ? 117.4 : 100 + i * 0.2,
      volume: 100,
    })),
    ...tail,
  ].map((b, i) => ({
    ...b,
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: b.close,
    high: b.close + 0.5,
    low: b.close - 0.5,
    amount: b.close * b.volume,
  }));
}
const interval = fixture([
  ...Array.from({ length: 7 }, (_, i) => ({
    close: i === 6 ? 119 : 117.8,
    volume: i % 3 === 0 ? 300 : 30,
  })),
  { close: 120, volume: 100 },
  { close: 121, volume: 100 },
]);
const isolated = fixture([
  { close: 119, volume: 300 },
  { close: 120, volume: 300 },
  { close: 121, volume: 100 },
  { close: 122, volume: 100 },
]).map((b, i) => (i >= 87 && i <= 89 ? { ...b, volume: 20 } : b));
const stall = fixture([
  { close: 120, volume: 200 },
  { close: 121.2, volume: 250 },
  { close: 121.806, volume: 300 },
  { close: 122, volume: 100 },
]);
const lowVolume = fixture([
  { close: 119, volume: 200 },
  { close: 120, volume: 100 },
  { close: 121, volume: 100 },
]);
const native = vi.fn(async () => {
  throw new Error("unexpected native");
});

it("identifies an isolated pulse only after its next bar and retains non-risk baseline entries", () => {
  const rows = researchVolumeContextSeries("vp-isolated-filter", isolated);
  expect(rows[90]!.multiDay!.isolatedRisk).toBe(true);
  expect(rows[90]!.entry).toBe(false);
  expect(rows[91]!.entry).toBe(true);
  expect(rows[91]!.ruleStop!.price).toBeCloseTo(117.9);
  const rejected = isolated.map((b, i) =>
    i === 91 ? { ...b, volume: 20 } : b,
  );
  const bad = researchVolumeContextSeries("vp-isolated-filter", rejected);
  expect(bad[91]!.decision).toContain("前后缩量形成孤量");
  expect(bad.slice(90).some((p) => p.entry)).toBe(false);
  const broken = isolated.map((b, i) => (i === 91 ? { ...b, low: 117 } : b));
  expect(
    researchVolumeContextSeries("vp-isolated-filter", broken)[91]!.entry,
  ).toBe(false);
  expect(
    researchVolumeContextSeries("vp-isolated-filter", lowVolume)[90]!.entry,
  ).toBe(true);
});

it("uses the most recent tied price high and compares its volume rather than an average", () => {
  const tied = fixture([
    { close: 119, volume: 200 },
    { close: 119, volume: 50 },
    { close: 120, volume: 100 },
  ]);
  const row = researchVolumeContextSeries("vp-high-low-volume-exit", tied)[92]!;
  expect(row.multiDay!.previousHigh).toEqual({
    date: tied[91]!.date,
    high: 119.5,
    volume: 50,
  });
  expect(row.exit).toBe(false);
  const lower = researchVolumeContextSeries(
    "vp-high-low-volume-exit",
    lowVolume,
  )[91]!;
  expect(lower.multiDay!.previousHigh!.volume).toBe(200);
  expect(lower.exit).toBe(true);
});

it("rejects a malformed interval, a missing bar and rising rather than contracting gains", () => {
  const malformed = interval.map((b, i) =>
    i === 94 ? { ...b, volume: 300 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-interval-3", malformed)[96]!.entry,
  ).toBe(false);
  const suspended = interval.map((b, i) =>
    i === 94 ? { ...b, volume: 0 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-interval-3", suspended)[96]!.reason,
  ).not.toBeNull();
  const increasing = stall.map((b, i) =>
    i === 92 ? { ...b, close: 123, open: 123, high: 123.5, low: 122.5 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-stall-exit", increasing)[92]!.exit,
  ).toBe(false);
  expect(native).not.toHaveBeenCalled();
});

const cases: [VolumeContextId, Bar[], number, number, number][] = [
  ["vp-interval-3", interval, 96, 97, 98],
  ["vp-isolated-filter", isolated, 91, 92, 93],
  ["vp-stall-exit", stall, 90, 91, 93],
  ["vp-high-low-volume-exit", lowVolume, 90, 91, 92],
];
it.each(cases)(
  "%s calculates volume sequence confirmation timing",
  (id, input, signalIndex) => {
    const points = researchVolumeContextSeries(id, input);
    expect(points.flatMap((p, i) => (p.entry && i >= 90 ? [i] : []))).toEqual([
      signalIndex,
    ]);
  },
);
