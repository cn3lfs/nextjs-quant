import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { confirmedExtrema } from "../../../../src/lib/indicators";
import {
  researchRuleSeries,
  isResearchRule,
} from "trading-strategies/research/composition/research-local-rules";
import {
  researchVolumeStructureSeries as series,
  volumeStructureIds,
} from "trading-strategies/research/volume/research-volume-structure";
function delayedRetest(index: number): Bar[] {
  const bars = fixture();
  for (let i = 91; i < bars.length; i++) {
    const close = i === index ? 151.5 : 153;
    Object.assign(bars[i]!, {
      open: close,
      close,
      high: close + 0.5,
      low: i === index ? 150.7 : 152.5,
      volume: 200,
    });
  }
  return bars;
}

function fixture(range = false): Bar[] {
  const anchors = range
    ? [
        [0, 100],
        [50, 100],
        [60, 105],
        [65, 95],
        [70, 105],
        [75, 95],
        [80, 105],
        [85, 95],
        [89, 100],
        [90, 107],
        [95, 110],
      ]
    : [
        [0, 60],
        [30, 90],
        [50, 115],
        [60, 130],
        [65, 122],
        [70, 140],
        [75, 134],
        [80, 150],
        [85, 143],
        [89, 149],
        [90, 152],
        [95, 157],
      ];
  return Array.from({ length: 96 }, (_, i) => {
    const right = anchors.findIndex((a) => a[0]! >= i),
      b = anchors[right]!,
      a = anchors[Math.max(0, right - 1)]!;
    const close =
      a[0] === b[0]
        ? a[1]!
        : a[1]! + ((b[1]! - a[1]!) * (i - a[0]!)) / (b[0]! - a[0]!);
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: i === 90 ? 300 : 100,
      amount: close * 100,
    };
  });
}
it("confirmed extrema require all three right bars and reject ties", () => {
  const bars = fixture();
  expect(
    confirmedExtrema(bars.slice(0, 83)).extrema.some((p) => p.index === 80),
  ).toBe(false);
  expect(
    confirmedExtrema(bars.slice(0, 84)).extrema.find((p) => p.index === 80)
      ?.confirmedAt,
  ).toBe(bars[83]!.date);
  bars[81]!.high = bars[80]!.high;
  expect(confirmedExtrema(bars).extrema.some((p) => p.index === 80)).toBe(
    false,
  );
});
it("registers structural breakouts and rejects insufficient volume", () => {
  for (const [id, bars] of [
    ["vp-structure-up", fixture()],
    ["vp-structure-range", fixture(true)],
  ] as const) {
    expect(isResearchRule(id)).toBe(true);
    expect(
      researchRuleSeries(id, bars, undefined, researchFormulaRuntime)[90]!
        .entry,
    ).toBe(true);
    bars[90]!.volume = 100;
    expect(series(id, bars)[90]!.entry).toBe(false);
  }
});
it("waits for an actual retest and cancels a broken frozen level", () => {
  const bars = fixture();
  Object.assign(bars[91]!, {
    open: 151,
    close: 151,
    high: 151.5,
    low: 150.5,
    volume: 200,
  });
  for (const id of ["vp-retest-1", "vp-retest-5"] as const) {
    const points = series(id, bars);
    expect(points[90]!.entry).toBe(false);
    expect(points[90]!.retest?.level).toBe(150.5);
    expect(points[91]!.entry).toBe(true);
    expect(points[91]!.ruleStop?.price).toBe(150.5);
  }
  bars[91]!.low = 150.4;
  expect(series("vp-retest-5", bars)[91]!.entry).toBe(false);
});
it("does not assemble pivots across suspension and preserves every historical prefix", () => {
  const bars = fixture();
  for (const id of volumeStructureIds) {
    const full = series(id, bars);
    for (let n = 80; n <= bars.length; n++)
      expect(series(id, bars.slice(0, n))).toEqual(full.slice(0, n));
  }
  bars[83]!.volume = 0;
  const point = series("vp-structure-up", bars)[90]!;
  expect(point.structure.barrier).toBe(bars[83]!.date);
  expect(point.structure.extrema).toEqual([]);
  expect(point.entry).toBe(false);
});

it("accepts the last allowed retest bar, expires one-bar waiting and does not revive an expired candidate", () => {
  const fifth = delayedRetest(95);
  expect(series("vp-retest-5", fifth)[95]!.entry).toBe(true);
  expect(
    series("vp-retest-1", fifth)
      .slice(90)
      .some((p) => p.entry),
  ).toBe(false);
  const expired = delayedRetest(96);
  expired.push({
    ...expired.at(-1)!,
    date: "2024-04-06",
    open: 151.5,
    close: 151.5,
    high: 152,
    low: 150.7,
  });
  expect(series("vp-retest-5", expired).at(-1)!.entry).toBe(false);
  const outside = delayedRetest(93);
  outside[93]!.low = 150.5 * 1.005 + 0.001;
  expect(series("vp-retest-5", outside)[93]!.entry).toBe(false);
  outside[93]!.low = 150.5 * 1.005;
  expect(series("vp-retest-5", outside)[93]!.entry).toBe(true);
});

it("isolates ambiguous extrema and invalidates pending retests on unavailable input", () => {
  const ambiguous = fixture();
  Object.assign(ambiguous[80]!, { high: 200, low: 1 });
  const row = series("vp-structure-up", ambiguous)[90]!;
  expect(row.structure.barrier).toBe(ambiguous[80]!.date);
  expect(row.structure.extrema.map((p) => p.index)).toEqual([85]);
  expect(row.entry).toBe(false);
  for (const volume of [0, NaN]) {
    const bars = delayedRetest(93);
    bars[91]!.volume = volume;
    const points = series("vp-retest-5", bars);
    expect(points[91]!.reason).not.toBeNull();
    expect(points.slice(91).some((p) => p.entry)).toBe(false);
  }
});

it.each(volumeStructureIds)(
  "%s calculates confirmed volume structure and stable evidence",
  (id) => {
    const input =
      id === "vp-structure-range"
        ? fixture(true)
        : id === "vp-retest-5"
          ? delayedRetest(93)
          : fixture();
    if (id === "vp-retest-1")
      Object.assign(input[91]!, {
        open: 151,
        close: 151,
        high: 151.5,
        low: 150.5,
        volume: 200,
      });
    const points = series(id, input);
    for (let n = 89; n <= input.length; n++)
      expect(series(id, input.slice(0, n))).toEqual(points.slice(0, n));
  },
);
