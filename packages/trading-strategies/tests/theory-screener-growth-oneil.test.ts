import { expect, it } from "vitest";
import {
  createGrowthOneilFamilyScreener,
  growthOneilSpecs,
} from "../src/screener/growth-oneil.js";
import type { TheoryScreenContext } from "../src/screener/types.js";

type Knot = [number, number];
// Interpolate closes, leaving unique wick extrema at the turning points.
function history(knots: Knot[], quietFrom = Infinity) {
  let segment = 1;
  const end = knots.at(-1)![0];
  return Array.from({ length: end + 1 }, (_, i) => {
    while (i > knots[segment]![0]) segment++;
    const [a, x] = knots[segment - 1]!,
      [b, y] = knots[segment]!;
    const close = x + ((y - x) * (i - a)) / (b - a);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      close,
      high: close + 0.1,
      low: close - 0.1,
      volume: i === end ? 230 : i >= quietFrom ? 55 : 100,
      amount: 1000,
    };
  });
}
const trend = history([
  [0, 40],
  [248, 99],
  [249, 102],
]);
const vcp = history(
  [
    [0, 65],
    [20, 100],
    [31, 82],
    [45, 98],
    [54, 92],
    [64, 97],
    [65, 100],
  ],
  59,
);
const cup = history(
  [
    [0, 65],
    [25, 100],
    [37, 77],
    [48, 78],
    [59, 99],
    [63, 94],
    [67, 98],
    [68, 102],
  ],
  60,
);
const double = history([
  [0, 70],
  [18, 100],
  [30, 80],
  [40, 92],
  [52, 79],
  [60, 90],
  [61, 94],
]);
const flat = history([
  [0, 80],
  [10, 94],
  [34, 95],
  [35, 97],
  [46, 102],
  [54, 96],
  [64, 101],
  [65, 104],
]);
const flag = history([
  [0, 58],
  [18, 55],
  [40, 100],
  [45, 86],
  [54, 98],
  [55, 103],
]);
const rising = history([
  [0, 75],
  [12, 95],
  [19, 85],
  [28, 99],
  [35, 90],
  [44, 103],
  [51, 95],
  [57, 102],
  [58, 105],
]);
const box = history([
  [0, 80],
  [25, 100],
  [29, 90],
  [39, 98],
  [40, 102],
]);
const cases: [string, typeof trend, number, string[]][] = [
  ["sepa-trend-template", trend, 99.1, ["upper", "lower"]],
  ["vcp-breakout", vcp, 98.1, ["outline", "neckline"]],
  ["cup-with-handle", cup, 99.1, ["outline", "neckline"]],
  ["oneil-double-bottom", double, 92.1, ["outline", "neckline"]],
  ["flat-base-on-base", flat, 102.1, ["upper", "lower"]],
  ["ascending-base-htf", flag, 100.1, ["upper", "lower"]],
  ["ascending-base-htf", rising, 103.1, ["outline", "neckline"]],
  ["darvas-box", box, 100.1, ["upper", "lower"]],
  ["canslim-composite", trend, 99.1, ["upper", "lower"]],
];
function match(
  slug: string,
  context: TheoryScreenContext,
  i = context.bars.length - 1,
) {
  return createGrowthOneilFamilyScreener(context)
    .at(i)
    .find((m) => m.methodId === "f09-" + slug);
}
it("exposes eight distinct growth methods for empty history", () => {
  expect(new Set(growthOneilSpecs.map((s) => s.id)).size).toBe(8);
  expect(createGrowthOneilFamilyScreener({ bars: [] }).at(0)).toEqual([]);
});
it.each(cases)(
  "%s detects its historical breakout and preserves it after future extremes",
  (slug, bars, pivot, kinds) => {
    const i = bars.length - 1;
    const m = match(slug, { bars });
    expect(m).toBeDefined();
    expect(m!.pivotPrice).toBeCloseTo(pivot);
    expect(m!.geometry.lines.map((l) => l.kind)).toEqual(kinds);
    for (const line of m!.geometry.lines) {
      expect(line.points.length).toBeGreaterThanOrEqual(2);
      for (const p of line.points) {
        expect(p.date).toBe(bars[p.index]!.date);
        expect(p.index).toBeLessThanOrEqual(i);
      }
    }
    expect(m!.rewardMultiple).toBeCloseTo(
      (m!.targetPrice! - m!.close) / (m!.close - m!.stopPrice!),
    );
    expect(m!.volumeRatio).toBeGreaterThan(2);
    expect(m!.score).toBeGreaterThanOrEqual(1);
    expect(m!.score).toBeLessThanOrEqual(5);
    const future = history([
      [0, 300],
      [4, 5],
      [8, 500],
    ]).map((b, j) => ({
      ...b,
      date: "2022-01-" + String(j + 1).padStart(2, "0"),
    }));
    expect(match(slug, { bars: [...bars, ...future] }, i)).toEqual(m);
    const rejected = bars.map((b, j) =>
      j === i ? { ...b, open: pivot, close: pivot } : b,
    );
    expect(match(slug, { bars: rejected })).toBeUndefined();
  },
);
it("uses historical financials and preserves a missing historical snapshot", () => {
  const slug = "canslim-composite";
  const context = {
    bars: trend,
    rpsAt: () => ({ rps120: 80 }),
    financials: { roe: 16 },
  };
  expect(match(slug, context)?.score).toBe(5);
  expect(match(slug, { ...context, financialsAt: () => null })?.score).toBe(4);
  expect(
    match(slug, {
      ...context,
      financials: null,
      financialsAt: (i) => (i === 249 ? { profitGrowthYoY: 25 } : null),
    })?.score,
  ).toBe(5);
  expect(
    match(slug, { ...context, rpsAt: () => ({ rps50: 79 }) }),
  ).toBeUndefined();
  expect(
    match("sepa-trend-template", { bars: trend, rpsAt: () => ({ rps50: 69 }) }),
  ).toBeUndefined();
});
it("requires a full 60-bar gain beating an aligned benchmark when using return leadership", () => {
  const bars = history([
    [0, 60],
    [10, 68],
    [69, 98],
    [70, 102],
  ]);
  expect(
    match("canslim-composite", { bars, benchmarkBars: bars }),
  ).toBeUndefined();
  expect(
    match("canslim-composite", {
      bars,
      benchmarkBars: bars.map((b) => ({
        ...b,
        open: 10,
        close: 10,
        high: 11,
        low: 9,
      })),
    }),
  ).toBeDefined();
});
it("requires volume contraction inside the cup handle and VCP tight zone", () => {
  for (const [slug, bars] of [
    ["cup-with-handle", cup],
    ["vcp-breakout", vcp],
  ] as const) {
    expect(
      match(slug, {
        bars: bars.map((b, i) => ({
          ...b,
          volume: i === bars.length - 1 ? 230 : 100,
        })),
      }),
    ).toBeUndefined();
  }
});
it("adds the stacked base bonus and invalidates a broken Darvas floor", () => {
  expect(match("flat-base-on-base", { bars: flat })?.score).toBe(5);
  const bars = box.map((b, i) => (i === 38 ? { ...b, low: 80 } : b));
  expect(match("darvas-box", { bars })).toBeUndefined();
});
