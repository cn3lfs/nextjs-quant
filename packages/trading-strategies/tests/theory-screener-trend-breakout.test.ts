import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  ema,
  macd,
  ma,
  rsi,
  williamsR,
} from "trading-strategy-core/indicators";
import {
  createTrendBreakoutFamilyScreener,
  trendBreakoutSpecs,
} from "../src/screener/trend-breakout.js";
import type {
  TheoryScreenContext,
  TheoryScreenMatch,
} from "../src/screener/types.js";

/** Linear close path between explicit [index, close] anchors. */
function path(total: number, anchors: readonly (readonly [number, number])[]) {
  const closes: number[] = Array(total).fill(Number.NaN);
  for (let a = 0; a < anchors.length - 1; a++) {
    const [startIndex, startPrice] = anchors[a]!;
    const [endIndex, endPrice] = anchors[a + 1]!;
    const span = endIndex - startIndex || 1;
    for (let k = startIndex; k <= endIndex; k++)
      closes[k] =
        startPrice + ((endPrice - startPrice) * (k - startIndex)) / span;
  }
  return closes;
}

function makeBars(
  closes: readonly number[],
  overrides: Readonly<Record<number, Partial<Bar>>> = {},
  volumes?: readonly number[],
): Bar[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const bar: Bar = {
      date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      open,
      // 让转折点的极值严格高于/低于相邻 bar，满足 confirmedExtrema 的 3/3 规则。
      high: Math.max(open, close * 1.005) * 1.01,
      low: Math.min(open, close * 0.995) * 0.99,
      close,
      volume: volumes?.[i] ?? 1000,
      amount: 1000 * close,
    };
    return { ...bar, ...overrides[i] };
  });
}

function scan(
  bars: readonly Bar[],
  methodId: string,
  extra: Partial<TheoryScreenContext> = {},
): TheoryScreenMatch[] {
  const prepared = createTrendBreakoutFamilyScreener({ bars, ...extra });
  const matches: TheoryScreenMatch[] = [];
  for (let i = 0; i < bars.length; i++)
    matches.push(...prepared.at(i).filter((m) => m.methodId === methodId));
  return matches;
}

function at(
  bars: readonly Bar[],
  methodId: string,
  index: number,
  extra: Partial<TheoryScreenContext> = {},
): TheoryScreenMatch {
  const match = scan(bars, methodId, extra).find((m) => m.index === index);
  expect(match).toBeDefined();
  return match!;
}

function expectLongRisk(match: TheoryScreenMatch) {
  expect(match.direction).toBe("long");
  expect(match.family).toBe("trend-breakout");
  expect(match.stopPrice).not.toBeNull();
  expect(match.targetPrice).not.toBeNull();
  expect(match.stopPrice!).toBeLessThan(match.close);
  expect(match.close).toBeLessThan(match.targetPrice!);
  expect(match.rewardMultiple).not.toBeNull();
  expect(match.rewardMultiple!).toBeGreaterThan(0);
  expect(match.score).toBeGreaterThanOrEqual(1);
  expect(match.score).toBeLessThanOrEqual(5);
  expect(match.summary.length).toBeGreaterThan(0);
  expect(match.geometry.lines.length).toBeGreaterThan(0);
}

describe("trend-breakout family contract", () => {
  it("exposes 14 unique long specs and answers empty history without indicators", () => {
    expect(trendBreakoutSpecs).toHaveLength(14);
    expect(new Set(trendBreakoutSpecs.map((s) => s.id)).size).toBe(14);
    for (const spec of trendBreakoutSpecs) {
      expect(spec.family).toBe("trend-breakout");
      expect(spec.direction).toBe("long");
      expect(spec.warmupBars).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
    const prepared = createTrendBreakoutFamilyScreener({ bars: [] });
    expect(prepared.specs).toEqual(trendBreakoutSpecs);
    expect(prepared.at(0)).toEqual([]);
  });

  it("reports method-specific ids and theory ids", () => {
    expect(trendBreakoutSpecs.map((s) => [s.id, s.theoryId])).toEqual([
      ["f02-dow-swing-break", "F02.09"],
      ["f02-support-rejection", "F02.04"],
      ["f02-trendline-break", "F02.05"],
      ["f02-livermore-pivotal", "F02.07"],
      ["f02-weinstein-stage2", "F02.08"],
      ["f03-ma-pullback-reclaim", "F03.05"],
      ["f03-macd-zero-accel", "F03.06"],
      ["f03-dmi-supertrend", "F03.09"],
      ["f03-ichimoku-break", "F03.10"],
      ["f03-triple-screen-daily", "F03.11"],
      ["f03-adaptive-trend-cross", "F03.13"],
      ["f04-turtle-donchian", "F04.02"],
      ["f04-ttm-squeeze", "F04.04"],
      ["f04-nr7-inside-break", "F04.07"],
    ]);
  });
});

const dowBars = () =>
  makeBars(
    path(50, [
      [0, 10.4],
      [10, 10.0],
      [20, 11.0],
      [30, 10.5],
      [40, 12.0],
      [43, 11.8],
      [45, 12.4],
      [49, 12.6],
    ]),
  );

const supportBars = () =>
  makeBars(
    path(72, [
      [0, 10.0],
      [20, 10.6],
      [35, 10.4],
      [42, 10.55],
      [48, 10.3],
      [55, 10.6],
      [60, 10.35],
      [66, 10.4],
      [70, 10.42],
      [71, 11.0],
    ]),
  );

const trendlineBars = () =>
  makeBars(
    path(57, [
      [0, 10.5],
      [10, 10.2],
      [20, 12.0],
      [30, 11.3],
      [40, 11.485],
      [45, 11.2],
      [52, 12.0],
      [56, 12.0],
    ]),
  );

const livermoreBars = () =>
  makeBars(
    path(71, [
      [0, 10.2],
      [20, 10.8],
      [30, 11.2],
      [40, 11.88],
      [45, 11.2],
      [50, 11.86],
      [54, 11.4],
      [58, 11.5],
      [64, 11.9],
      [65, 12.3],
      [70, 12.4],
    ]),
    {},
    Array.from({ length: 71 }, (_, i) => (i === 65 ? 1600 : 1000)),
  );

const weinsteinBars = () =>
  makeBars(
    path(171, [
      [0, 9.8],
      [60, 10.6],
      [100, 12.0],
      [140, 12.05],
      [169, 12.1],
      [170, 12.7],
    ]),
    {},
    Array.from({ length: 171 }, (_, i) => (i === 170 ? 1600 : 1000)),
  );

const pullbackBars = () =>
  makeBars(
    path(77, [
      [0, 10.0],
      [55, 13.0],
      [65, 12.8],
      [69, 12.75],
      [70, 13.2],
      [76, 13.3],
    ]),
  );

const macdBars = () =>
  makeBars(
    path(76, [
      [0, 10.0],
      [45, 12.8],
      [53, 12.2],
      [61, 13.0],
      [75, 13.1],
    ]),
  );

const dmiBars = () =>
  makeBars(
    path(72, [
      [0, 12.0],
      [30, 10.0],
      [59, 10.85],
      [60, 11.5],
      [71, 11.6],
    ]),
  );

const ichimokuBars = () =>
  makeBars(
    path(126, [
      [0, 10.0],
      [40, 11.4],
      [99, 12.8],
      [104, 13.0],
      [112, 11.5],
      [119, 11.9],
      [120, 13.3],
      [125, 13.4],
    ]),
  );

const tripleBars = () =>
  makeBars(
    path(70, [
      [0, 10.0],
      [40, 10.0],
      [60, 9.4],
      [64, 9.4],
      [65, 11.0],
      [69, 11.1],
    ]),
  );

const adaptiveBars = () =>
  makeBars(
    path(66, [
      [0, 10.0],
      [59, 12.0],
      [62, 11.8],
      [64, 11.85],
      [65, 12.45],
    ]),
  );

const turtleBars = () =>
  makeBars(
    path(26, [
      [0, 10.0],
      [23, 10.5],
      [25, 11.2],
    ]),
  );

const squeezeBars = () =>
  makeBars(
    path(40, [
      [0, 10.8],
      [10, 11.6],
      [16, 12.0],
      [20, 11.85],
      [22, 12.15],
      [24, 11.85],
      [26, 12.15],
      [28, 11.85],
      [30, 12.15],
      [32, 11.85],
      [34, 12.15],
      [35, 12.0],
      [36, 12.6],
      [39, 12.6],
    ]),
  );

const nr7Bars = () =>
  makeBars(
    path(70, [
      [0, 10.0],
      [62, 12.0],
      [63, 11.95],
    ]),
    {
      63: { open: 11.95, high: 11.98, low: 11.9, close: 11.95 },
      64: { open: 11.99, high: 12.01, low: 11.99, close: 12.0 },
      65: { open: 12.0, high: 12.55, low: 12.0, close: 12.5 },
    },
  );

const insideBars = () =>
  makeBars(
    path(70, [
      [0, 10.0],
      [62, 12.0],
      [63, 12.02],
    ]),
    {
      63: { open: 11.8, high: 12.2, low: 11.7, close: 12.0 },
      64: { open: 12.0, high: 12.1, low: 11.8, close: 11.95 },
      65: { open: 11.95, high: 12.45, low: 11.79, close: 12.4 },
    },
  );

const scenarios: readonly {
  id: string;
  bars: () => Bar[];
  index: number;
  extra?: () => Partial<TheoryScreenContext>;
}[] = [
  { id: "f02-dow-swing-break", bars: dowBars, index: 45 },
  { id: "f02-support-rejection", bars: supportBars, index: 71 },
  { id: "f02-trendline-break", bars: trendlineBars, index: 48 },
  { id: "f02-livermore-pivotal", bars: livermoreBars, index: 65 },
  { id: "f02-weinstein-stage2", bars: weinsteinBars, index: 170 },
  { id: "f03-ma-pullback-reclaim", bars: pullbackBars, index: 70 },
  { id: "f03-macd-zero-accel", bars: macdBars, index: 61 },
  { id: "f03-dmi-supertrend", bars: dmiBars, index: 60 },
  { id: "f03-ichimoku-break", bars: ichimokuBars, index: 121 },
  { id: "f03-triple-screen-daily", bars: tripleBars, index: 65 },
  { id: "f03-adaptive-trend-cross", bars: adaptiveBars, index: 65 },
  { id: "f04-turtle-donchian", bars: turtleBars, index: 25 },
  { id: "f04-ttm-squeeze", bars: squeezeBars, index: 36 },
  { id: "f04-nr7-inside-break", bars: nr7Bars, index: 65 },
];

describe("trend-breakout methods", () => {
  it("every method fires at its designed bar with a complete, ordered plan", () => {
    for (const scenario of scenarios) {
      const match = at(
        scenario.bars(),
        scenario.id,
        scenario.index,
        scenario.extra?.(),
      );
      expectLongRisk(match);
      expect(match.index).toBe(scenario.index);
      for (const line of match.geometry.lines) {
        expect(line.points.length).toBeGreaterThanOrEqual(2);
        for (const point of line.points) {
          expect(point.date).toBe(scenario.bars()[point.index]!.date);
          expect(point.price).toBeGreaterThan(0);
        }
      }
    }
  });

  it("f02-dow-swing-break pins the higher-low stop and measured target", () => {
    const match = at(dowBars(), "f02-dow-swing-break", 45);
    expect(match.pivotPrice).toBeCloseTo(12.0 * 1.005 * 1.01, 6);
    expect(match.stopPrice).toBeCloseTo(10.5 * 0.995 * 0.99, 6);
    expect(match.targetPrice).toBeCloseTo(
      12.0 * 1.005 * 1.01 + (12.0 * 1.005 * 1.01 - 10.0 * 0.995 * 0.99),
      6,
    );
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "neckline",
      "outline",
    ]);
  });

  it("f02-support-rejection pins the reclaim trigger and padded stop", () => {
    const match = at(supportBars(), "f02-support-rejection", 71);
    expect(match.pivotPrice).toBeCloseTo(10.42 * 1.005 * 1.01, 6);
    expect(match.stopPrice!).toBeLessThan(10.42 * 0.995 * 0.99);
    expect(match.geometry.lines[0]!.kind).toBe("lower");
  });

  it("f02-trendline-break projects the two-high line and uses the prior low", () => {
    const match = at(trendlineBars(), "f02-trendline-break", 48);
    expect(match.stopPrice).toBeCloseTo(11.3 * 0.995 * 0.99, 6);
    expect(match.pivotPrice!).toBeGreaterThan(match.stopPrice!);
    expect(match.pivotPrice!).toBeLessThan(match.close);
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "lower",
      "upper",
    ]);
  });

  it("f02-livermore-pivotal needs repeated resistance, shallow reaction and volume", () => {
    const bars = livermoreBars();
    const match = at(bars, "f02-livermore-pivotal", 65);
    expect(match.volumeRatio!).toBeGreaterThanOrEqual(1.4);
    expect(match.pivotPrice).toBeCloseTo(11.88 * 1.005 * 1.01, 6);
    expect(scan(bars, "f02-livermore-pivotal")).toHaveLength(1);
  });

  it("f02-livermore-pivotal accepts a leading benchmark or RPS20", () => {
    const bars = livermoreBars();
    const benchmarkBars = makeBars(bars.map(() => 100));
    expect(
      scan(bars, "f02-livermore-pivotal", { benchmarkBars }).some(
        (m) => m.index === 65,
      ),
    ).toBe(true);
    const rpsAt = (index: number) => (index === 65 ? { rps20: 88 } : null);
    expect(
      scan(bars, "f02-livermore-pivotal", { rpsAt }).some(
        (m) => m.index === 65,
      ),
    ).toBe(true);
  });

  it("f02-weinstein-stage2 stops at the lower of MA150 and the base low", () => {
    const bars = weinsteinBars();
    const match = at(bars, "f02-weinstein-stage2", 170);
    expect(match.volumeRatio!).toBeGreaterThanOrEqual(1.4);
    expect(match.stopPrice!).toBeLessThan(match.pivotPrice!);
    expect(match.pivotPrice).toBeCloseTo(12.1 * 1.005 * 1.01, 6);
  });

  it("f03-ma-pullback-reclaim reclaims EMA20 inside a bullish alignment", () => {
    const match = at(pullbackBars(), "f03-ma-pullback-reclaim", 70);
    expect(match.pivotPrice).toBeCloseTo(12.75 * 1.005 * 1.01, 6);
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "lower",
      "upper",
    ]);
  });

  it("f03-macd-zero-accel fires on a zero-axis golden cross", () => {
    const bars = macdBars();
    const matches = scan(bars, "f03-macd-zero-accel");
    expect(matches.length).toBeGreaterThan(0);
    const points = macd(bars);
    for (const match of matches) {
      expect(points[match.index]!.dif!).toBeGreaterThan(0);
      expect(match.close).toBeGreaterThan(ma(bars, 60)[match.index]!);
    }
  });

  it("f03-dmi-supertrend requires supertrend, DI and rising ADX agreement", () => {
    const match = at(dmiBars(), "f03-dmi-supertrend", 60);
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "lower",
      "upper",
    ]);
  });

  it("f03-ichimoku-break needs conversion above base and a close over the cloud", () => {
    const match = at(ichimokuBars(), "f03-ichimoku-break", 121);
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "lower",
      "upper",
    ]);
  });

  it("f03-triple-screen-daily needs tide up, an oversold dip and a trigger", () => {
    const bars = tripleBars();
    at(bars, "f03-triple-screen-daily", 65);
    expect(ema(bars, 20)[65]!).toBeGreaterThan(ema(bars, 20)[60]!);
    expect(rsi(bars, [14, 14, 14])[64]!.rsi6!).toBeLessThan(42);
    expect(
      williamsR(bars, 14)[64]! < -75 || rsi(bars, [14, 14, 14])[64]!.rsi6! < 42,
    ).toBe(true);
  });

  it("f03-adaptive-trend-cross reclaims KAMA and the prior five-bar high", () => {
    const bars = adaptiveBars();
    const match = at(bars, "f03-adaptive-trend-cross", 65);
    const priorFiveHigh = Math.max(
      ...bars.slice(60, 65).map((bar) => bar.high),
    );
    expect(match.pivotPrice).toBeCloseTo(priorFiveHigh, 6);
    expect(match.stopPrice!).toBeLessThan(match.close);
  });

  it("f04-turtle-donchian breaks the 20-bar high and stops at the 10-bar low", () => {
    const match = at(turtleBars(), "f04-turtle-donchian", 25);
    expect(match.pivotPrice).toBeCloseTo(10.85 * 1.005 * 1.01, 6);
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "lower",
      "upper",
    ]);
  });

  it("f04-ttm-squeeze releases after at least three bars inside the Keltner channel", () => {
    const match = at(squeezeBars(), "f04-ttm-squeeze", 36);
    expect(match.pivotPrice!).toBeGreaterThan(match.stopPrice!);
    expect(match.stopPrice!).toBeCloseTo(11.678, 2);
    expect(match.geometry.lines.map((line) => line.kind).sort()).toEqual([
      "lower",
      "upper",
    ]);
  });

  it("f04-nr7-inside-break breaks out of an NR7 contraction", () => {
    const match = at(nr7Bars(), "f04-nr7-inside-break", 65);
    expect(match.pivotPrice).toBeCloseTo(12.01, 6);
    expect(match.stopPrice).toBeCloseTo(11.99, 6);
  });

  it("f04-nr7-inside-break also accepts a strict inside bar", () => {
    const match = at(insideBars(), "f04-nr7-inside-break", 65);
    expect(match.pivotPrice).toBeCloseTo(12.2, 6);
    expect(match.stopPrice).toBeCloseTo(11.7, 6);
  });
});

describe("trend-breakout causality", () => {
  it("never depends on bars after the signal", () => {
    for (const scenario of [
      { bars: dowBars(), id: "f02-dow-swing-break", index: 45 },
      { bars: pullbackBars(), id: "f03-ma-pullback-reclaim", index: 70 },
    ]) {
      const full = at(scenario.bars, scenario.id, scenario.index);
      const truncated = createTrendBreakoutFamilyScreener({
        bars: scenario.bars.slice(0, scenario.index + 1),
      }).at(scenario.index);
      expect(truncated.find((m) => m.methodId === full.methodId)).toEqual(full);
    }
  });

  it("returns nothing before warmup or on invalid bars", () => {
    const bars = makeBars(
      path(40, [
        [0, 10.0],
        [39, 12.0],
      ]),
    );
    const prepared = createTrendBreakoutFamilyScreener({ bars });
    expect(prepared.at(5)).toEqual([]);
    const invalid = bars.map((bar, i) =>
      i === 30 ? { ...bar, close: Number.NaN } : bar,
    );
    expect(createTrendBreakoutFamilyScreener({ bars: invalid }).at(30)).toEqual(
      [],
    );
  });
});
