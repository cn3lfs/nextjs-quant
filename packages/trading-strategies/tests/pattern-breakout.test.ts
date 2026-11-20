import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  analyzePatternBreakouts,
  preparePatternBreakout,
  type PatternBreakoutMatch,
} from "../src/pattern-breakout.js";
import { validateScreenFormula } from "../src/formula/formula-screen.js";
import { patternFormulaPresets } from "../src/formula/pattern-formula-presets.js";
import { candle, reflectBars } from "./ohlc-fixtures.js";

const reflection = 220;
type Direction = PatternBreakoutMatch["direction"];
type Lines = PatternBreakoutMatch["geometry"]["lines"];
type Coordinate = [index: number, price: number];

function shoulders(): Bar[] {
  // Only the five named wicks are strict extrema. The neck rises 0.5/bar.
  const bars = Array.from({ length: 30 }, (_, i) => candle(i, 100));
  bars[4] = candle(4, 100, { low: 94 });
  bars[9] = candle(9, 100, { high: 110 });
  bars[14] = candle(14, 100, { low: 84 });
  bars[19] = candle(19, 100, { high: 115 });
  bars[24] = candle(24, 100, { low: 95 });
  bars[29] = candle(29, 122, { open: 112, volume: 200 });
  return bars;
}

function channel(
  upper: readonly [intercept: number, slope: number],
  lower: readonly [intercept: number, slope: number],
  direction: Direction,
): Bar[] {
  const bars = Array.from({ length: 25 }, (_, i) => {
    const top = upper[0] + upper[1] * i;
    const floor = lower[0] + lower[1] * i;
    const middle = (top + floor) / 2;
    if (i === 24) {
      return candle(i, direction === "long" ? top + 2 : floor - 2, {
        open: middle,
        volume: 200,
      });
    }
    if (i === 4 || i === 14) return candle(i, middle, { high: top });
    if (i === 8 || i === 18) return candle(i, middle, { low: floor });
    return candle(i, middle);
  });
  return bars;
}

const fallingWedge = channel([135, -1.25], [90, -0.5], "long");
// A late wick below the projected floor exercises the wider structural stop.
fallingWedge[23] = { ...fallingWedge[23]!, low: 76 };

type PatternCase = {
  kind: PatternBreakoutMatch["kind"];
  subKind: PatternBreakoutMatch["subKind"];
  direction: Direction;
  bars: Bar[];
  pivot: number;
  stop: number;
  target: number;
  height: number;
  lines: { kind: Lines[number]["kind"]; coordinates: Coordinate[] }[];
};

const cases: PatternCase[] = [
  {
    kind: "head-shoulders-bottom",
    subKind: "头肩底",
    direction: "long",
    bars: shoulders(),
    pivot: 120,
    stop: 95,
    target: 148.5, // At the head the neck is 112.5, so height = 112.5 - 84.
    height: 28.5,
    lines: [
      {
        kind: "neckline",
        coordinates: [
          [9, 110],
          [29, 120],
        ],
      },
      {
        kind: "outline",
        coordinates: [
          [4, 94],
          [9, 110],
          [14, 84],
          [19, 115],
          [24, 95],
        ],
      },
    ],
  },
  {
    kind: "head-shoulders-top",
    subKind: "头肩顶",
    direction: "short",
    bars: reflectBars(shoulders(), reflection),
    pivot: 100,
    stop: 125,
    target: 71.5,
    height: 28.5,
    lines: [
      {
        kind: "neckline",
        coordinates: [
          [9, 110],
          [29, 100],
        ],
      },
      {
        kind: "outline",
        coordinates: [
          [4, 126],
          [9, 110],
          [14, 136],
          [19, 105],
          [24, 125],
        ],
      },
    ],
  },
];

type ChannelCase = {
  kind: "box" | "triangle" | "wedge";
  subKind: PatternCase["subKind"];
  direction: Direction;
  bars: Bar[];
  start: number;
  upper: [startPrice: number, endPrice: number];
  lower: [startPrice: number, endPrice: number];
  levels: [pivot: number, stop: number, target: number];
};

const channelCases: ChannelCase[] = [
  {
    kind: "box",
    subKind: "水平箱体",
    direction: "long",
    bars: channel([110, 0], [100, 0], "long"),
    start: 4,
    upper: [110, 110],
    lower: [100, 100],
    levels: [110, 100, 120],
  },
  {
    kind: "box",
    subKind: "水平箱体",
    direction: "short",
    bars: channel([110, 0], [100, 0], "short"),
    start: 4,
    upper: [110, 110],
    lower: [100, 100],
    levels: [100, 110, 90],
  },
  {
    kind: "triangle",
    subKind: "对称三角形",
    direction: "long",
    bars: channel([120, -0.5], [80, 0.5], "long"),
    start: 0,
    upper: [120, 108],
    lower: [80, 92],
    levels: [108, 92, 148],
  },
  {
    kind: "triangle",
    subKind: "对称三角形",
    direction: "short",
    bars: channel([120, -0.5], [80, 0.5], "short"),
    start: 0,
    upper: [120, 108],
    lower: [80, 92],
    levels: [92, 108, 52],
  },
  {
    kind: "triangle",
    subKind: "上升三角形",
    direction: "long",
    bars: channel([120, 0], [80, 1], "long"),
    start: 0,
    upper: [120, 120],
    lower: [80, 104],
    levels: [120, 104, 160],
  },
  {
    kind: "triangle",
    subKind: "上升三角形",
    direction: "short",
    bars: channel([120, 0], [80, 1], "short"),
    start: 0,
    upper: [120, 120],
    lower: [80, 104],
    levels: [104, 120, 64],
  },
  {
    kind: "triangle",
    subKind: "下降三角形",
    direction: "long",
    bars: channel([120, -1], [80, 0], "long"),
    start: 0,
    upper: [120, 96],
    lower: [80, 80],
    levels: [96, 80, 136],
  },
  {
    kind: "triangle",
    subKind: "下降三角形",
    direction: "short",
    bars: channel([120, -1], [80, 0], "short"),
    start: 0,
    upper: [120, 96],
    lower: [80, 80],
    levels: [80, 96, 40],
  },
  {
    kind: "wedge",
    subKind: "下降楔形",
    direction: "long",
    bars: fallingWedge,
    start: 0,
    upper: [135, 105],
    lower: [90, 78],
    levels: [105, 76, 150],
  },
  {
    kind: "wedge",
    subKind: "上升楔形",
    direction: "short",
    bars: reflectBars(fallingWedge, reflection),
    start: 0,
    upper: [130, 142],
    lower: [85, 115],
    levels: [115, 144, 70],
  },
];

for (const {
  kind,
  subKind,
  direction,
  bars,
  start,
  upper,
  lower,
  levels,
} of channelCases) {
  const end = bars.length - 1;
  const [pivot, stop, target] = levels;
  cases.push({
    kind,
    subKind,
    direction,
    bars,
    pivot,
    stop,
    target,
    height: upper[0] - lower[0],
    lines: [
      {
        kind: "upper",
        coordinates: [
          [start, upper[0]],
          [end, upper[1]],
        ],
      },
      {
        kind: "lower",
        coordinates: [
          [start, lower[0]],
          [end, lower[1]],
        ],
      },
    ],
  });
}

it.each(cases)(
  "$subKind $direction confirms the measured move and geometry",
  ({ kind, subKind, direction, bars, pivot, stop, target, height, lines }) => {
    const index = bars.length - 1;
    const { close, date } = bars[index]!;
    const sign = direction === "long" ? 1 : -1;
    const options = { kinds: [kind], direction, minVolumeRatio: 2 };
    const [match] = preparePatternBreakout(bars, options).at(index);
    expect(match).toMatchObject({
      kind,
      subKind,
      direction,
      index,
      date,
      close,
      pivotPrice: pivot,
      stopPrice: stop,
      targetPrice: target,
      volumeRatio: 2,
    });
    expect(match?.rewardMultiple).toBeCloseTo(
      (target - close) / (close - stop),
      10,
    );
    expect((close - pivot) * sign).toBeGreaterThan(0);
    expect((pivot - stop) * sign).toBeGreaterThan(0);
    expect((target - close) * sign).toBeGreaterThan(0);
    expect((target - pivot) * sign).toBe(height);
    expect(
      match?.geometry.lines.map(({ kind, points }) => ({ kind, points })),
    ).toEqual(
      lines.map(({ kind, coordinates }) => ({
        kind,
        points: coordinates.map(([index, price]) => ({
          index,
          date: bars[index]!.date,
          price,
        })),
      })),
    );
  },
);

it.each(cases)(
  "$subKind $direction preserves all historical matches after future extremes",
  ({ kind, direction, bars }) => {
    const index = bars.length - 1;
    const options = { kinds: [kind], direction };
    const baseline = analyzePatternBreakouts(bars, options);
    expect(baseline.map((match) => match.index)).toEqual([index]);
    const appended = [
      ...bars,
      candle(index + 1, 300, { high: 500, low: 1, volume: 10000 }),
      candle(index + 2, 4, { open: 200, high: 400, low: 2 }),
      candle(index + 3, 220),
      candle(index + 4, 6),
    ];
    expect(
      analyzePatternBreakouts(appended, options).filter(
        (match) => match.index <= index,
      ),
    ).toEqual(baseline);
    const prepared = preparePatternBreakout(appended, options);
    prepared.at(appended.length - 1);
    expect(prepared.at(index)).toEqual(baseline);
  },
);

it.each(cases)(
  "$subKind $direction refuses a repeat after an earlier close through the boundary",
  ({ kind, direction, bars }) => {
    const index = bars.length - 1;
    const changed = bars.slice();
    const sign = direction === "long" ? 1 : -1;
    // This close also becomes the box's high/low boundary. For sloped shapes
    // it occurs after the last anchor, with too few bars to replace that anchor.
    const prior = index - 2;
    changed[prior] = candle(prior, bars[index]!.close + sign, {
      open: bars[prior]!.open,
    });
    expect(
      preparePatternBreakout(changed, { kinds: [kind], direction }).at(index),
    ).toEqual([]);
  },
);

it.each(cases)(
  "$subKind $direction requires all three right peers before the breakout bar",
  ({ kind, direction, bars, lines }) => {
    const lastAnchor = kind.startsWith("head-shoulders") ? 24 : 18;
    const index = lastAnchor + 3;
    const end = bars.length - 1;
    const changed = bars.slice();
    const railPrice = (line: PatternCase["lines"][number], i: number) => {
      const [start, first] = line.coordinates[0]!;
      const [, last] = line.coordinates[1]!;
      return first + ((last - first) * (i - start)) / (end - start);
    };
    if (direction === "short" && (kind === "box" || kind === "triangle")) {
      // Put the pending resistance at 18 and support at 14. The sell candle
      // can be the third right peer of a high without disqualifying the high.
      changed[14] = candle(14, bars[14]!.close, {
        low: railPrice(lines[1]!, 14),
      });
      changed[18] = candle(18, bars[18]!.close, {
        high: railPrice(lines[0]!, 18),
      });
    }
    const options = { kinds: [kind], direction };
    expect(preparePatternBreakout(changed, options).at(end)).toHaveLength(1);
    const long = direction === "long";
    const boundary = lines.find(
      (line) =>
        line.kind === "neckline" || line.kind === (long ? "upper" : "lower"),
    )!;
    changed[index] = candle(
      index,
      railPrice(boundary, index) + (long ? 2 : -2),
      {
        open: bars[index]!.close,
        volume: 200,
      },
    );
    const peers = changed
      .slice(lastAnchor - 3, lastAnchor + 4)
      .filter((bar) => bar !== changed[lastAnchor]);
    expect(
      peers.every((peer) =>
        long
          ? peer.low > changed[lastAnchor]!.low
          : peer.high < changed[lastAnchor]!.high,
      ),
    ).toBe(true);
    expect(
      preparePatternBreakout(changed.slice(0, index + 1), options).at(index),
    ).toEqual([]);
    const prepared = preparePatternBreakout(changed, options);
    prepared.at(changed.length - 1);
    expect(prepared.at(index)).toEqual([]);
  },
);

it.each(patternFormulaPresets)(
  "$name passes static screening validation",
  (preset) => {
    expect(validateScreenFormula(preset)).toEqual({
      ...preset,
      parameters: {},
    });
  },
);

it("rejects a future-reference expression substituted into a valid preset", () => {
  const preset = patternFormulaPresets[0];
  const source = preset.source.replace("REF(LLV(L,6),25)", "REF(LLV(L,6),-1)");
  expect(() => validateScreenFormula({ ...preset, source })).toThrow(
    /REF 偏移为负数/,
  );
});

it("anchors box rails on confirmed touches despite an unconfirmed wick, and requires remaining reward", () => {
  const bars = channel([110, 0], [100, 0], "long");
  bars[23] = candle(23, 105, { high: 130 });
  const atBreak = () =>
    preparePatternBreakout(bars, { kinds: ["box"], direction: "long" }).at(24);
  expect(atBreak()).toMatchObject([{ pivotPrice: 110, targetPrice: 120 }]);
  bars[24] = candle(24, 120);
  expect(atBreak()).toEqual([]);
});
