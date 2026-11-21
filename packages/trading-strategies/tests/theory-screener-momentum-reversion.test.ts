import { describe, expect, it } from "vitest";
import { createWaveHarmonicSmcFamilyScreener } from "../src/screener/wave-harmonic-smc.js";
import type { Bar } from "trading-strategy-core/bars";
import {
  createMomentumReversionFamilyScreener,
  momentumReversionSpecs,
} from "../src/screener/momentum-reversion.js";
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
  volumes?: readonly number[],
): Bar[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      close,
      volume: volumes?.[i] ?? 1000,
      amount: close * 1000,
    };
  });
}

function scan(
  bars: readonly Bar[],
  methodId: string,
  extra: Partial<TheoryScreenContext> = {},
): TheoryScreenMatch[] {
  const prepared = createMomentumReversionFamilyScreener({ bars, ...extra });
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
  expect(match.family).toBe("momentum-reversion");
  expect(match.stopPrice).not.toBeNull();
  expect(match.targetPrice).not.toBeNull();
  // 交付契约：每个信号都必须满足 stop < close < target 且 reward 非空。
  expect(match.stopPrice!).toBeLessThan(match.close);
  expect(match.close).toBeLessThan(match.targetPrice!);
  expect(match.rewardMultiple).not.toBeNull();
  expect(match.rewardMultiple!).toBeGreaterThan(0);
  expect(match.score).toBeGreaterThanOrEqual(1);
  expect(match.score).toBeLessThanOrEqual(5);
  expect(match.summary.length).toBeGreaterThan(0);
  expect(match.geometry.lines.length).toBeGreaterThan(0);
}

function breakoutPath(toLast: number, last: number) {
  return makeBars(
    path(131, [
      [0, 10],
      [toLast, 18],
      [129, 19],
      [130, last],
    ]),
  );
}

describe("momentum-reversion family contract", () => {
  it("exposes 7 unique specs and answers empty history without indicators", () => {
    expect(momentumReversionSpecs).toHaveLength(7);
    expect(new Set(momentumReversionSpecs.map((s) => s.id)).size).toBe(7);
    for (const spec of momentumReversionSpecs) {
      expect(spec.family).toBe("momentum-reversion");
      expect(spec.direction).toBe("long");
      expect(spec.warmupBars).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
    }
    const prepared = createMomentumReversionFamilyScreener({ bars: [] });
    expect(prepared.specs).toEqual(momentumReversionSpecs);
    expect(prepared.at(0)).toEqual([]);
  });

  it("reports method-specific ids, theory ids and warmups", () => {
    expect(
      momentumReversionSpecs.map((s) => [s.id, s.theoryId, s.warmupBars]),
    ).toEqual([
      ["f10-rps-triple-red", "F10.06", 65],
      ["f10-rps-turnaround", "F10.06", 65],
      ["f10-dual-momentum-12-1", "F10.05", 130],
      ["f12-trend-rsi2-pullback", "F12.10", 125],
      ["f12-bollinger-zscore-reentry", "F12.02", 65],
      ["f12-oscillator-divergence-reclaim", "F12.05", 65],
      ["f12-five-factor-confluence", "F03.06", 65],
    ]);
  });

  it("emits nothing during warmup or on a too-short series", () => {
    const bars = makeBars(
      path(40, [
        [0, 10],
        [39, 20],
      ]),
    );
    const prepared = createMomentumReversionFamilyScreener({ bars });
    for (let i = 0; i < 40; i++) expect(prepared.at(i)).toEqual([]);
    expect(createMomentumReversionFamilyScreener({ bars: [] }).at(0)).toEqual(
      [],
    );
  });
});

describe("f10 momentum methods", () => {
  it("f10-rps-triple-red accepts causal multi-horizon returns without rpsAt", () => {
    const bars = breakoutPath(120, 20);
    const match = at(bars, "f10-rps-triple-red", 130);
    expectLongRisk(match);
    expect(match.pivotPrice!).toBeLessThan(match.close);
  });

  it("f10-rps-triple-red honours rpsAt and rejects a weak long-term line", () => {
    const bars = breakoutPath(120, 20);
    const passes = at(bars, "f10-rps-triple-red", 130, {
      rpsAt: (i) => (i === 130 ? { rps20: 90, rps50: 88, rps120: 86 } : null),
    });
    expectLongRisk(passes);
    expect(
      scan(bars, "f10-rps-triple-red", {
        rpsAt: (i) => (i === 130 ? { rps20: 90, rps50: 90, rps120: 80 } : null),
      }),
    ).toEqual([]);
  });

  it("f10-rps-turnaround detects a short-horizon surge after a flat base", () => {
    const bars = makeBars(
      path(131, [
        [0, 10],
        [70, 10],
        [110, 10.3],
        [129, 12],
        [130, 12.6],
      ]),
    );
    const match = at(bars, "f10-rps-turnaround", 130);
    expectLongRisk(match);
    expect(match.pivotPrice!).toBeLessThan(match.close);
  });

  it("f10-rps-turnaround uses rpsAt when present and rejects hot long-term RPS", () => {
    const bars = makeBars(
      path(131, [
        [0, 10],
        [70, 10],
        [110, 10.3],
        [129, 12],
        [130, 12.6],
      ]),
    );
    const rpsAt = (i: number) =>
      i === 130 ? { rps10: 90, rps120: 60 } : i === 129 ? { rps10: 70 } : null;
    expectLongRisk(at(bars, "f10-rps-turnaround", 130, { rpsAt }));
    expect(
      scan(bars, "f10-rps-turnaround", {
        rpsAt: (i) => (i === 130 ? { rps10: 90, rps120: 80 } : null),
      }),
    ).toEqual([]);
  });

  it("f10-dual-momentum-12-1 needs the skip-month edge over the benchmark", () => {
    const bars = makeBars(
      path(131, [
        [0, 8],
        [10, 8],
        [120, 11],
        [129, 11.3],
        [130, 11.6],
      ]),
    );
    const match = at(bars, "f10-dual-momentum-12-1", 130);
    expectLongRisk(match);
    expect(match.pivotPrice!).toBeLessThan(match.close);
    const stronger = makeBars(
      path(131, [
        [0, 8],
        [10, 8],
        [120, 13],
        [130, 13.5],
      ]),
    );
    expect(
      scan(bars, "f10-dual-momentum-12-1", { benchmarkBars: stronger }),
    ).toEqual([]);
  });
});

describe("f12 reversion methods", () => {
  it("f12-trend-rsi2-pullback buys the first right-side bar after an RSI2 extreme", () => {
    const bars = makeBars(
      path(131, [
        [0, 10],
        [100, 20],
        [125, 24],
        [128, 21],
        [129, 20.2],
        [130, 21.2],
      ]),
    );
    const match = at(bars, "f12-trend-rsi2-pullback", 130);
    expectLongRisk(match);
    expect(match.pivotPrice).toBe(bars[129]!.close);
  });

  it("f12-bollinger-zscore-reentry re-enters the band after a close below it", () => {
    const bars = makeBars(
      path(131, [
        [0, 10],
        [100, 20],
        [125, 20],
        [127, 19.8],
        [128, 19],
        [129, 18.6],
        [130, 20],
      ]),
    );
    const match = at(bars, "f12-bollinger-zscore-reentry", 130);
    expectLongRisk(match);
    expect(match.pivotPrice!).toBeLessThan(match.close);
  });

  it("f12-oscillator-divergence-reclaim needs two reclaiming oscillators", () => {
    const bars = makeBars(
      path(131, [
        [0, 10],
        [60, 20],
        [100, 20],
        [120, 20],
        [127, 19.8],
        [128, 19],
        [129, 18.6],
        [130, 20.4],
      ]),
    );
    const match = at(bars, "f12-oscillator-divergence-reclaim", 130);
    expectLongRisk(match);
    expect(match.pivotPrice).toBe(bars[129]!.high);
    // 缺少收盘收复前高时不得触发。
    const noReclaim = makeBars(
      path(131, [
        [0, 10],
        [60, 20],
        [100, 20],
        [120, 20],
        [127, 19.8],
        [128, 19],
        [129, 18.6],
        [130, 18.9],
      ]),
    );
    expect(scan(noReclaim, "f12-oscillator-divergence-reclaim")).toEqual([]);
  });

  it("f12-five-factor-confluence needs a volume breakout with 4 of 5 votes", () => {
    const closes = Array.from(
      { length: 131 },
      (_, k) => 8 + 0.09 * k + (k % 5 === 4 ? -0.6 : 0),
    );
    closes[130] = Math.max(...closes.slice(110, 130)) * 1.04;
    const volumes = Array.from({ length: 131 }, () => 1000);
    volumes[130] = 2000;
    const bars = makeBars(closes, volumes);
    const match = at(bars, "f12-five-factor-confluence", 130);
    expectLongRisk(match);
    expect(match.volumeRatio!).toBeGreaterThanOrEqual(1.3);
    expect(match.pivotPrice!).toBeLessThan(match.close);
    // 缩量时不得突破触发。
    const quiet = Array.from({ length: 131 }, () => 1000);
    expect(scan(makeBars(closes, quiet), "f12-five-factor-confluence")).toEqual(
      [],
    );
  });
});

describe("Wave 5/6 signal regressions", () => {
  const dual = "f10-dual-momentum-12-1";
  const turnaround = "f10-rps-turnaround";
  const i = 130;
  const bars = makeBars(
    path(131, [
      [0, 8],
      [10, 8],
      [120, 11],
      [129, 11.3],
      [130, 11.6],
    ]),
  );

  it("compares skip returns at stock dates using the latest available benchmark close", () => {
    const early = bars[9]!;
    const late = bars[119]!;
    const future = { ...bars[121]!, close: 99 };
    expectLongRisk(at(bars, dual, i, { benchmarkBars: [early, late, future] }));
    expect(
      scan(bars, dual, {
        benchmarkBars: [early, late, { ...bars[120]!, close: 15 }, future],
      }),
    ).toEqual([]);
  });

  it("suppresses dual momentum on absent or invalid required benchmark closes", () => {
    for (const benchmarkBars of [
      [],
      [bars[11]!],
      [bars[10]!],
      [bars[10]!, bars[i - 21]!],
      [{ ...bars[0]!, date: "2019-12-31" }, bars[120]!],
      [{ ...bars[10]!, close: 0 }, bars[120]!],
      [bars[10]!, { ...bars[120]!, close: NaN }],
    ]) {
      expect(scan(bars, dual, { benchmarkBars })).toEqual([]);
    }
  });

  it("requires price confirmation even on a short RPS crossover", () => {
    const blocked = bars.map((bar, k) =>
      k === i - 5 ? { ...bar, high: 15 } : bar,
    );
    expect(
      scan(blocked, turnaround, {
        rpsAt: (k) => ({ rps20: k === i ? 90 : 75, rps120: 60 }),
      }),
    ).toEqual([]);
  });

  it("requires all three finite RPS values on a confirmed breakout", () => {
    const matches = (
      short: number | null,
      prev: number | null,
      long: number | null,
    ) =>
      scan(bars, turnaround, {
        rpsAt: (k) =>
          k === i ? { rps20: short, rps120: long } : { rps20: prev },
      });
    expect(matches(90, 70, 60)).toHaveLength(1);
    expect(matches(85, 84, 60)).toHaveLength(1);
    expect(matches(90, 95, 60)).toEqual([]);
    expect(matches(90, 85, 60)).toEqual([]);
    for (const invalid of [null, NaN, Infinity]) {
      expect(matches(invalid, 70, 60)).toEqual([]);
      expect(matches(90, invalid, 60)).toEqual([]);
      expect(matches(90, 70, invalid)).toEqual([]);
    }
  });

  it("rejects reentry when a sharp rebound drives the current lower band below zero", () => {
    const closes = Array<number>(131).fill(20);
    closes[129] = 16;
    closes[130] = 200;
    expect(scan(makeBars(closes), "f12-bollinger-zscore-reentry")).toEqual([]);
  });

  it("plots the golden-pocket reclaim only once when the signal bar sets the retracement low", () => {
    const candles = makeBars(Array<number>(81).fill(100));
    candles[63] = { ...candles[63]!, low: 90 };
    candles[68] = { ...candles[68]!, high: 110 };
    candles[80] = { ...candles[80]!, low: 98, high: 105, close: 104 };
    const match = createWaveHarmonicSmcFamilyScreener({ bars: candles })
      .at(80)
      .find((item) => item.methodId === "f06-fibonacci-golden-pocket");
    const outline = match?.geometry.lines.find(
      (item) => item.kind === "outline",
    );
    expect(outline?.points.map((point) => point.index)).toEqual([63, 68, 80]);
    expect(outline?.points.at(-1)?.price).toBe(104);
  });
});
