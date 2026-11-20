import { expect, it } from "vitest";
import {
  analyzeBreakout,
  evaluateBreakoutFilter,
  type DoubleBreakoutFilter,
} from "../src/research/breakout/breakout.js";
import {
  prepareStrategy,
  type StrategyObjectInput,
} from "../src/strategy-object.js";
import { candle, reflectBars } from "./ohlc-fixtures.js";

const breakoutIndex = 64;
function upwardBreakout() {
  const bars = Array.from({ length: breakoutIndex + 1 }, (_, i) =>
    candle(i, 114),
  );
  bars[3] = candle(3, 114, { high: 132 }); // Outside the 60 completed bars (4..63).
  bars[16] = candle(16, 114, { high: 132 });
  bars[28] = candle(28, 114, { high: 128.25 });
  bars[40] = candle(40, 114, { high: 120 });
  bars[48] = candle(48, 114, { high: 122 });
  bars[54] = candle(54, 114, { low: 109 });
  bars[61] = candle(61, 113);
  bars[62] = candle(62, 112);
  bars[63] = candle(63, 111);
  bars[64] = candle(64, 119, {
    open: 111,
    high: 119.5,
    low: 110.5,
    volume: 200,
  });
  return bars;
}

const sides = [
  {
    direction: "long",
    linePrice: 117,
    slope: -0.3125,
    anchors: [128.25, 122],
    key: 113.7,
    stop: 109,
    target1: 120,
    target2: 122,
  },
  {
    direction: "short",
    linePrice: 113,
    slope: 0.3125,
    anchors: [101.75, 108],
    key: 116.3,
    stop: 121,
    target1: 110,
    target2: 108,
  },
] as const;

it.each(sides)(
  "backtracks to an unbroken $direction line and confirms the two breaks",
  ({ direction, linePrice, slope, anchors, key, stop, target1, target2 }) => {
    const upward = upwardBreakout();
    const bars = direction === "long" ? upward : reflectBars(upward, 230);
    const point = analyzeBreakout(bars).latest!;
    const side = point[direction];
    const sign = direction === "long" ? 1 : -1;
    const swingKind = direction === "long" ? "high" : "low";
    const targetSource = direction === "long" ? "swing-high" : "swing-low";
    const swings = point.swings.filter((swing) => swing.kind === swingKind);
    expect(swings.map(({ index }) => index)).toEqual([16, 28, 40, 48]);
    // 120 -> 122 rises for resistance; its reflection falls for support.
    expect((swings[3]!.price - swings[2]!.price) * sign).toBe(2);
    expect(side.line).toMatchObject({
      direction,
      anchors: [
        { index: 28, price: anchors[0], confirmedAt: bars[31]!.date },
        { index: 48, price: anchors[1], confirmedAt: bars[51]!.date },
      ],
      slope,
      value: linePrice, // 122 - (64 - 48) * 0.3125 for the falling resistance.
      confirmedAt: bars[51]!.date,
      touches: 3, // Index 16 lies on the same extension; index 40 does not.
    });
    expect(side.keyLevel?.price).toBeCloseTo(key, 10);
    expect(side.keyLevel?.source).toBe("ma20");
    expect(point.volume20).toBe(100);
    expect(point.volumeRatio).toBe(2);
    expect(side).toMatchObject({
      status: "是",
      checks: {
        trend: "是",
        level: "是",
        volume: "是",
        indicators: "是",
        candle: "否",
      },
      score: 4,
      quality: "4/5",
      risk: {
        stop: {
          price: stop,
          source: direction === "long" ? "swing-low" : "swing-high",
          index: 54,
        },
        target1: { price: target1, source: targetSource, index: 40 },
        target2: { price: target2, source: targetSource, index: 48 },
        rewardMultiple: 3 / 10,
      },
    });
    expect((point.close - stop) * sign).toBe(10);
    expect((target2 - point.close) * sign).toBe(3);
  },
);

it.each(sides)(
  "applies every filter independently at the $direction thresholds",
  ({ direction, stop, target2 }) => {
    const upward = upwardBreakout();
    const bars = direction === "long" ? upward : reflectBars(upward, 230);
    const point = analyzeBreakout(bars).latest!;
    const bar = bars[breakoutIndex]!;
    const filter: DoubleBreakoutFilter = {
      direction,
      minScore: 4,
      minTouches: 3,
      minSpanBars: 20,
      minVolumeRatio: 2,
      requireLargeBody: true,
      minRewardMultiple: 3 / 10,
    };
    expect(evaluateBreakoutFilter(point, bar, filter)).toMatchObject({
      matched: true,
      direction,
      stopPrice: stop,
      targetPrice: target2,
      rewardMultiple: 3 / 10,
    });
    const tightened: Record<string, DoubleBreakoutFilter> = {
      oppositeDirection: { direction: direction === "long" ? "short" : "long" },
      score: { minScore: 5 },
      touches: { minTouches: 4 },
      span: { minSpanBars: 21 },
      volume: { minVolumeRatio: 2.01 },
      reward: { minRewardMultiple: 0.31 },
    };
    for (const [name, threshold] of Object.entries(tightened)) {
      expect(
        evaluateBreakoutFilter(point, bar, { ...filter, ...threshold }),
        name,
      ).toMatchObject({
        matched: false,
        direction: null,
        stopPrice: null,
        targetPrice: null,
        rewardMultiple: null,
      });
    }
  },
);

it.each([
  {
    reason: "3% of the opening price",
    open: 118,
    high: 119.5,
    low: 117.9, // Body 1 / range 1.6 > 60%, but 1 / 118 < 3%.
  },
  {
    reason: "60% of the range",
    open: 111,
    high: 125,
    low: 110.5, // Body 8 / open 111 > 3%, but 8 / 14.5 < 60%.
  },
])(
  "rejects an otherwise valid double breakout with a body below $reason",
  ({ open, high, low }) => {
    const bars = upwardBreakout();
    const bar = candle(breakoutIndex, 119, { open, high, low, volume: 200 });
    bars[breakoutIndex] = bar;
    const point = analyzeBreakout(bars).latest!;
    expect(
      evaluateBreakoutFilter(point, bar, { direction: "long" }).matched,
    ).toBe(true);
    expect(
      evaluateBreakoutFilter(point, bar, {
        direction: "long",
        requireLargeBody: true,
      }).matched,
    ).toBe(false);
  },
);

it.each(["long", "short"] as const)(
  "rejects every $direction rail pierced by a previous close",
  (direction) => {
    const upward = upwardBreakout();
    // At index 60 the rail is 118.25. Equal highs keep 60 and 61 from
    // becoming new strict swings, so rejection is due to the earlier close.
    upward[60] = candle(60, 118.5, { high: 119.5 });
    upward[61] = candle(61, 113, { high: 119.5 });
    const bars = direction === "long" ? upward : reflectBars(upward, 230);
    const point = analyzeBreakout(bars).latest!;
    const kind = direction === "long" ? "high" : "low";
    expect(
      point.swings
        .filter((swing) => swing.kind === kind)
        .map(({ index }) => index),
    ).toEqual([16, 28, 40, 48]);
    expect(point[direction].line).toBeNull();
    expect(
      evaluateBreakoutFilter(point, bars[breakoutIndex]!, { direction })
        .matched,
    ).toBe(false);
  },
);

it("does not borrow a descending anchor from outside the 60-bar window", () => {
  const bars = upwardBreakout();
  bars[16] = candle(16, 114);
  bars[28] = candle(28, 114);
  // Index 3 at 132 and index 48 at 122 would form an unpierced line if
  // index 3 were eligible. The only in-window anchors are rising.
  const point = analyzeBreakout(bars).latest!;
  expect(
    point.swings
      .filter((swing) => swing.kind === "high")
      .map(({ index }) => index),
  ).toEqual([40, 48]);
  expect(point.long.line).toBeNull();
});

it("keeps the breakout point identical when extreme future bars are appended", () => {
  const bars = upwardBreakout();
  const baseline = analyzeBreakout(bars).latest!;
  expect(baseline.long.status).toBe("是");
  const appended = [
    ...bars,
    candle(65, 340, { high: 500, low: 1, volume: 10000 }),
    candle(66, 3, { open: 330 }),
    candle(67, 380),
  ];
  expect(analyzeBreakout(appended, breakoutIndex).points[0]).toEqual(baseline);
});

function upwardBox() {
  const bars = Array.from({ length: 25 }, (_, i) => candle(i, 105));
  bars[4] = candle(4, 105, { high: 110 });
  bars[8] = candle(8, 105, { low: 100 });
  bars[14] = candle(14, 105, { high: 110 });
  bars[18] = candle(18, 105, { low: 100 });
  bars[24] = candle(24, 112, { open: 105, volume: 200 });
  return bars;
}

it.each([
  {
    entry: { kind: "double-breakout", side: "entry" },
    bars: upwardBreakout(),
    stopLevel: 109,
  },
  {
    entry: { kind: "pattern-breakout", patterns: ["box"] },
    bars: upwardBox(),
    stopLevel: 100,
  },
] satisfies {
  entry: StrategyObjectInput["entry"];
  bars: ReturnType<typeof upwardBreakout>;
  stopLevel: number;
}[])(
  "$entry.kind forwards the long structure stop on the entry bar by default",
  ({ entry, bars, stopLevel }) => {
    const strategy: StrategyObjectInput = {
      id: "structure-stop",
      version: 1,
      market: "cn-equity",
      period: "day",
      universe: { kind: "symbols", symbols: ["sh600000"] },
      entry,
      exit: { maxBars: 10 },
      sizing: { kind: "weight", weight: 0.1 },
      sleeve: "swing",
    };
    const index = bars.length - 1;
    const prepared = prepareStrategy(strategy, bars);
    expect(prepared.evaluate(index - 1)).toMatchObject({ stopLevel: null });
    expect(prepared.evaluate(index)).toMatchObject({
      entry: true,
      exit: false,
      stopLevel,
    });
    expect(
      prepareStrategy(
        {
          ...strategy,
          entry: { ...entry, useStructureStop: false },
        },
        bars,
      ).evaluate(index),
    ).toMatchObject({ entry: true, stopLevel: null });
  },
);

it.each(["long", "short"] as const)(
  "does not replace a pierced correctly sloped latest %s rail",
  (direction) => {
    const bars = upwardBreakout();
    bars[40] = candle(40, 114, { high: 122 });
    bars[48] = candle(48, 114, { high: 120 });
    // At 60 the latest rail is 117, while the older 16/28 rail is 118.25.
    bars[60] = candle(60, 117.5, { high: 118 });
    bars[61] = candle(61, 113, { high: 118 });
    expect(
      analyzeBreakout(direction === "long" ? bars : reflectBars(bars, 230))
        .latest![direction].line,
    ).toBeNull();
  },
);
