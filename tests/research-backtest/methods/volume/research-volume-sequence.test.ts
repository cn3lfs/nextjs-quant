import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { linearSlope, volumeMa } from "../../../../src/lib/indicators";
import {
  researchVolumeSequenceSeries as series,
  volumeSequenceIds,
  hasVolumePulses,
  type VolumeSequenceId,
} from "trading-strategies/research/volume/research-volume-sequence";
import { researchVolumeContextSeries } from "trading-strategies/research/volume/research-volume-context";
function fixture(tail: { close: number; volume: number }[]): Bar[] {
  return [
    ...Array.from({ length: 90 }, (_, i) => ({
      close: 100 + i * 0.2,
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
function pulseFixture(gap: number, count: number) {
  const n = (gap + 1) * (count - 1) + 1;
  return fixture([
    ...Array.from({ length: n }, (_, i) => ({
      close: i === n - 1 ? 119 : 117.8,
      volume: i % (gap + 1) === 0 ? 300 : 30,
    })),
    { close: 119.2, volume: 100 },
    { close: 119.4, volume: 100 },
    { close: 119.6, volume: 100 },
  ]);
}
function forId(id: VolumeSequenceId): {
  bars: Bar[];
  signal: number;
  exit: number;
} {
  if (id.startsWith("vp-pulse")) {
    const [, , g, c] = id.split("-"),
      gap = Number(g),
      count = Number(c),
      signal = 90 + (gap + 1) * (count - 1);
    return { bars: pulseFixture(gap, count), signal, exit: signal + 2 };
  }
  if (id.startsWith("vp-center"))
    return {
      bars: fixture(
        Array.from({ length: 12 }, (_, i) => ({
          close: 118.2 + i * 0.1,
          volume: i < 5 ? 200 + i * 10 : 10,
        })),
      ),
      signal: 91,
      exit: 97,
    };
  if (id === "vp-contract-5" || id.startsWith("vp-slope-down"))
    return {
      bars: fixture([
        ...[200, 160, 120, 100, 80].map((volume) => ({ close: 118.2, volume })),
        { close: 119, volume: 300 },
        { close: 119.2, volume: 100 },
        { close: 119.4, volume: 100 },
        { close: 119.6, volume: 100 },
      ]),
      signal: 95,
      exit: 97,
    };
  return {
    bars: fixture(
      [140, 170, 200, 230, 260, 260, 260, 260, 260].map((volume, i) => ({
        volume,
        close: 118.2 + i * 0.1,
      })),
    ),
    signal: id === "vp-stack-5" ? 94 : 90,
    exit: id === "vp-stack-5" ? 96 : 92,
  };
}
it("uses least-squares slope with no fabricated values or overflow", () => {
  expect(linearSlope([1, 2, 4])).toBeCloseTo(1.5);
  expect(linearSlope([101, 102, 104])).toBeCloseTo(1.5);
  expect(linearSlope([100, 150, 140])).toBeCloseTo(20);
  expect(linearSlope([3, 1, 2])).toBeCloseTo(-0.5);
  expect(linearSlope([1e308, 1e308, 1e308])).toBe(0);
  expect(linearSlope([1e308, -1e308])).toBeNull();
  for (const values of [[], [1], [1, null, 2], [1, NaN, 2], [1, Infinity]])
    expect(linearSlope(values)).toBeNull();
});
it("retains the existing gap-two three-pulse strategy and rejects malformed rhythm", () => {
  for (const gap of [1, 2, 3])
    for (const count of [2, 3]) {
      const ratios: (number | null)[] = Array.from(
        { length: (gap + 1) * (count - 1) + 1 },
        (_, i) => (i % (gap + 1) === 0 ? 1.5 : 0.79),
      );
      expect(hasVolumePulses(ratios, gap, count)).toBe(true);
      ratios[1] = 0.8;
      expect(hasVolumePulses(ratios, gap, count)).toBe(false);
      ratios[1] = null;
      expect(hasVolumePulses(ratios, gap, count)).toBe(false);
    }
  const bars = pulseFixture(2, 3),
    rows = researchVolumeContextSeries("vp-interval-3", bars);
  expect(rows.flatMap((p, i) => (p.entry ? [i] : []))).toEqual([96]);
  bars[94]!.volume = 300;
  expect(researchVolumeContextSeries("vp-interval-3", bars)[96]!.entry).toBe(
    false,
  );
});
it("distinguishes a regression direction from strict stacking and uses shared effective-record means", () => {
  const bars = fixture([
    { close: 118.2, volume: 100 },
    { close: 118.3, volume: 150 },
    { close: 118.4, volume: 140 },
  ]);
  const p = series("vp-slope-up-3", bars)[92]!;
  expect(p.sequence.slope).toBeCloseTo(20);
  expect(p.sequence.strictUp).toBe(false);
  expect(p.sequence.trigger).toBe(true);
  for (const n of [5, 10, 20]) {
    const id = `vp-center-${n}` as VolumeSequenceId,
      input = forId(id).bars,
      rows = series(id, input),
      means = volumeMa(input, n);
    expect(rows[94]!.sequence.meanValues).toEqual(means.slice(92, 95));
    expect(rows[96]!.sequence.centerDown).toBe(true);
  }
});
it("cancels a contraction on low break and does not bridge zero-volume or one-price gaps", () => {
  for (const id of [
    "vp-slope-down-3",
    "vp-slope-down-5",
    "vp-contract-5",
  ] as const) {
    const bars = forId(id).bars;
    bars[95]!.low = 110;
    expect(
      series(id, bars)
        .slice(90)
        .some((p) => p.entry),
    ).toBe(false);
  }
  for (const id of volumeSequenceIds) {
    const { bars, signal } = forId(id);
    bars[signal - 1]!.volume = 0;
    expect(series(id, bars)[signal]!.entry).toBe(false);
    const one = forId(id).bars,
      b = one[signal - 1]!;
    Object.assign(b, { open: b.close, high: b.close, low: b.close });
    expect(series(id, one)[signal]!.entry).toBe(false);
  }
});

it("allows the tenth confirmation bar but never revives the expired contraction", () => {
  const base = forId("vp-contract-5").bars.slice(0, 95);
  const extend = (at: number) => [
    ...base,
    ...Array.from({ length: 12 }, (_, i) => {
      const index = 95 + i,
        close = index === at ? 119 : 118.2,
        volume = index === at ? 300 : 80;
      return {
        ...base.at(-1)!,
        date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
        open: close,
        close,
        high: close + 0.5,
        low: close - 0.5,
        volume,
      };
    }),
  ];
  expect(series("vp-contract-5", extend(104))[104]!.entry).toBe(true);
  expect(series("vp-contract-5", extend(105)).some((p) => p.entry)).toBe(false);
});

it.each(volumeSequenceIds)(
  "%s calculates volume sequence entry at confirmation",
  (id) => {
    const { bars, signal } = forId(id),
      points = series(id, bars);
    expect(points.flatMap((p, i) => (p.entry ? [i] : []))).toEqual([signal]);
  },
);
