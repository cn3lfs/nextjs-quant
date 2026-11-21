import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  astockDragonSpecs,
  createAstockDragonFamilyScreener,
} from "../src/screener/astock-dragon.js";
import type {
  TheoryScreenContext,
  TheoryScreenMatch,
} from "../src/screener/types.js";

type Override = Partial<
  Pick<Bar, "open" | "high" | "low" | "close" | "volume">
>;

/** Default bar keeps the prior close as open and pads the wicks. */
function bars(
  closes: readonly number[],
  options: {
    volumes?: readonly number[];
    overrides?: Readonly<Record<number, Override>>;
    pad?: number;
  } = {},
): Bar[] {
  const pad = options.pad ?? 0.05;
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    const bar: Bar = {
      date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      open,
      high: Math.max(open, close) + pad,
      low: Math.min(open, close) - pad,
      close,
      volume: options.volumes?.[i] ?? 100,
      amount: close * 100,
    };
    return { ...bar, ...options.overrides?.[i] };
  });
}

function find(
  context: TheoryScreenContext,
  slug: string,
  index = context.bars.length - 1,
): TheoryScreenMatch | undefined {
  return createAstockDragonFamilyScreener(context)
    .at(index)
    .find((match) => match.methodId === "f11-" + slug);
}

function expectValidMatch(
  match: TheoryScreenMatch | undefined,
  index: number,
  source: readonly Bar[],
) {
  expect(match).toBeDefined();
  const hit = match!;
  expect(hit.family).toBe("astock-dragon");
  expect(hit.direction).toBe("long");
  expect(hit.index).toBe(index);
  expect(hit.date).toBe(source[index]!.date);
  expect(hit.close).toBe(source[index]!.close);
  expect(hit.pivotPrice).toBeGreaterThan(0);
  expect(hit.stopPrice).toBeGreaterThan(0);
  expect(hit.targetPrice).toBeGreaterThan(0);
  expect(hit.rewardMultiple).toBeCloseTo(
    (hit.targetPrice! - hit.close) / (hit.close - hit.stopPrice!),
  );
  expect(hit.volumeRatio).toBeGreaterThan(0);
  expect(hit.score).toBeGreaterThanOrEqual(1);
  expect(hit.score).toBeLessThanOrEqual(5);
  expect(hit.summary.length).toBeGreaterThan(0);
  expect(hit.geometry.lines.length).toBeGreaterThanOrEqual(2);
  for (const line of hit.geometry.lines) {
    expect(line.points.length).toBeGreaterThanOrEqual(2);
    for (const point of line.points) {
      expect(point.index).toBeGreaterThanOrEqual(0);
      expect(point.index).toBeLessThanOrEqual(index);
      expect(point.date).toBe(source[point.index]!.date);
    }
  }
}

const trendCloses = [
  ...Array.from({ length: 60 }, (_, k) => 10 + (5 * k) / 59),
  ...Array.from({ length: 10 }, (_, k) => 15 + (2.5 * k) / 9),
  17.4,
  17.3,
  17.2,
  17.3,
  17.4,
  18.5,
];
const trendVolumes = trendCloses.map((_, i) => (i === 75 ? 200 : 100));

// Same alignment and pause, but the 20-bar gain is below 15%.
const slowTrendCloses = [
  ...Array.from({ length: 60 }, (_, k) => 10 + (7 * k) / 59),
  ...Array.from({ length: 15 }, () => 17.4),
  18,
];
const slowTrendVolumes = slowTrendCloses.map((_, i) => (i === 75 ? 200 : 100));

const flatTen = Array.from({ length: 24 }, () => 10);

const firstLimitUpBars = bars([...flatTen, 11], {
  volumes: [...Array.from({ length: 24 }, () => 100), 200],
});
const oneWordBars = bars([...flatTen, 11], {
  overrides: { 24: { open: 11, high: 11, low: 11, close: 11 } },
});
const oneWordHeavyBars = bars([...flatTen, 11], {
  volumes: [...Array.from({ length: 24 }, () => 100), 200],
  overrides: { 24: { open: 11, high: 11, low: 11, close: 11 } },
});
const notFirstLimitUpBars = bars(
  [...Array.from({ length: 22 }, () => 10), 11, 12.1, 13.31],
  {
    volumes: [...Array.from({ length: 24 }, () => 100), 200],
  },
);

const streakBars = bars([...Array.from({ length: 23 }, () => 10), 11, 12.1], {
  volumes: [...Array.from({ length: 24 }, () => 100), 200],
});
const singleBoardBars = bars([...Array.from({ length: 24 }, () => 10), 11], {
  volumes: [...Array.from({ length: 24 }, () => 100), 200],
});
const oneWordStreakBars = bars(
  [...Array.from({ length: 23 }, () => 10), 11, 12.1],
  {
    volumes: [...Array.from({ length: 23 }, () => 100), 100, 50],
    overrides: { 24: { open: 12.1, high: 12.1, low: 12.1, close: 12.1 } },
  },
);

const weakToStrongBars = bars(
  [
    ...Array.from({ length: 24 }, () => 10),
    10.7,
    10.9,
    11.1,
    11.3,
    11.2,
    11.95,
  ],
  {
    volumes: [...Array.from({ length: 29 }, () => 100), 150],
    overrides: {
      28: { open: 11.1, high: 11.9, low: 11.05, close: 11.2 },
      29: { open: 11.2, high: 12, low: 11.15, close: 11.95 },
    },
  },
);

const firstYinBars = bars(
  [...Array.from({ length: 23 }, () => 10), 11, 12.1, 13.31, 14, 14.3, 14.2],
  {
    volumes: [
      ...Array.from({ length: 23 }, () => 100),
      200,
      200,
      200,
      200,
      200,
      150,
    ],
    overrides: {
      23: { open: 10, high: 11.05, low: 9.95, close: 11 },
      24: { open: 11, high: 12.15, low: 10.95, close: 12.1 },
      25: { open: 12.1, high: 13.36, low: 12.05, close: 13.31 },
      26: { open: 13.31, high: 14.05, low: 13.26, close: 14 },
      27: { open: 14, high: 14.35, low: 13.95, close: 14.3 },
      28: { open: 14.5, high: 14.6, low: 13.9, close: 14.2 },
    },
  },
);

const reclaimBars = bars(
  [...Array.from({ length: 24 }, () => 10), 10.5, 10.35, 10.9],
  {
    volumes: [...Array.from({ length: 26 }, () => 100), 150],
    overrides: {
      24: { open: 10, high: 10.55, low: 9.95, close: 10.5 },
      25: { open: 10.6, high: 10.65, low: 10.3, close: 10.35 },
      26: { open: 10.4, high: 10.95, low: 10.3, close: 10.9 },
    },
  },
);

const waveCloses = [
  ...Array.from({ length: 41 }, (_, k) => 10 + (8 * k) / 40),
  ...Array.from({ length: 13 }, (_, k) => 18 + (12 * (k + 1)) / 13),
  ...Array.from({ length: 15 }, (_, k) => 30 - (3.8 * (k + 1)) / 15),
  27.8,
];
const waveVolumes = waveCloses.map((_, i) => {
  if (i >= 41 && i <= 53) return 300;
  if (i === 69) return 250;
  return 100;
});
const secondWaveBars = bars(waveCloses, { volumes: waveVolumes });
const looseVolumeBars = bars(waveCloses, {
  volumes: waveVolumes.map((v, i) =>
    i >= 54 && i <= 68 ? 300 : i === 69 ? 500 : v,
  ),
});
const thinLaunchBars = bars(waveCloses, {
  volumes: waveVolumes.map((v, i) => (i === 69 ? 100 : v)),
});

function futureBars(source: readonly Bar[]): Bar[] {
  return Array.from({ length: 5 }, (_, k) => ({
    date: new Date(Date.UTC(2026, 0, 1) + k * 86_400_000)
      .toISOString()
      .slice(0, 10),
    open: 1000 + k,
    high: 1200 + k,
    low: 900 - k,
    close: 1000 + k,
    volume: 10,
    amount: 10_000,
  }));
}

function expectCausal(
  slug: string,
  source: readonly Bar[],
  context: { rpsAt?: TheoryScreenContext["rpsAt"] } = {},
) {
  const index = source.length - 1;
  const hit = find({ bars: source, ...context }, slug, index);
  expectValidMatch(hit, index, source);
  const extended = { bars: [...source, ...futureBars(source)], ...context };
  expect(find(extended, slug, index)).toEqual(hit);
  return hit;
}

describe("astock-dragon specs", () => {
  it("exposes seven long-only F11 methods and an empty history guard", () => {
    expect(astockDragonSpecs).toHaveLength(7);
    expect(new Set(astockDragonSpecs.map((spec) => spec.id)).size).toBe(7);
    for (const spec of astockDragonSpecs)
      expect(spec).toMatchObject({
        family: "astock-dragon",
        direction: "long",
      });
    expect(createAstockDragonFamilyScreener({ bars: [] }).at(0)).toEqual([]);
  });

  it("ignores invalid and out-of-range indexes", () => {
    const screener = createAstockDragonFamilyScreener({
      bars: bars(trendCloses, { volumes: trendVolumes }),
    });
    expect(screener.at(-1)).toEqual([]);
    expect(screener.at(1.5)).toEqual([]);
    expect(screener.at(19)).toEqual([]);
    expect(screener.at(trendCloses.length)).toEqual([]);
  });
});

describe("astock-dragon detection", () => {
  it("detects the trend-capacity leader breakout and preserves it causally", () => {
    const hit = expectCausal(
      "trend-leader",
      bars(trendCloses, { volumes: trendVolumes }),
    );
    expect(hit!.pivotPrice).toBeCloseTo(17.55);
    expect(hit!.stopPrice).toBeLessThan(hit!.close);
  });

  it("accepts a relative-strength leader when the 20-bar gain is short", () => {
    const source = bars(slowTrendCloses, { volumes: slowTrendVolumes });
    expect(find({ bars: source }, "trend-leader")).toBeUndefined();
    expect(
      find({ bars: source, rpsAt: () => ({ rps20: 90 }) }, "trend-leader"),
    ).toBeDefined();
    expect(
      find(
        { bars: source, rpsAt: () => ({ rps20: 84, rps50: 84 }) },
        "trend-leader",
      ),
    ).toBeUndefined();
  });

  it("rejects the trend leader without breakout volume", () => {
    const quiet = bars(trendCloses, {
      volumes: trendCloses.map(() => 100),
    });
    expect(find({ bars: quiet }, "trend-leader")).toBeUndefined();
  });

  it("detects a first limit-up leaving a tight base", () => {
    const hit = expectCausal("first-limit-up-break", firstLimitUpBars);
    expect(hit!.pivotPrice).toBeCloseTo(10.05);
    expect(hit!.stopPrice).toBeCloseTo(10);
    expect(hit!.targetPrice).toBeCloseTo(13.2);
  });

  it("uses the board price-limit ratio for STAR/ChiNext symbols", () => {
    const star = bars([...flatTen, 12], {
      volumes: [...Array.from({ length: 24 }, () => 100), 200],
    });
    expect(find({ bars: star }, "first-limit-up-break")).toBeUndefined();
    const hit = find(
      { bars: star, symbol: "sh688001" },
      "first-limit-up-break",
    );
    expectValidMatch(hit, 24, star);
    expect(hit!.targetPrice).toBeCloseTo(16.8);
  });

  it("requires turnover for a one-word board and rejects a second limit-up", () => {
    expect(find({ bars: oneWordBars }, "first-limit-up-break")).toBeUndefined();
    expect(
      find({ bars: oneWordHeavyBars }, "first-limit-up-break"),
    ).toBeDefined();
    expect(
      find({ bars: notFirstLimitUpBars }, "first-limit-up-break"),
    ).toBeUndefined();
  });

  it("detects a limit-up streak with a tradeable board", () => {
    const hit = expectCausal("limit-up-streak", streakBars);
    expect(hit!.pivotPrice).toBeCloseTo(11);
    expect(hit!.summary).toContain("2连板");
  });

  it("rejects a single board and an illiquid one-word streak", () => {
    expect(find({ bars: singleBoardBars }, "limit-up-streak")).toBeUndefined();
    expect(
      find({ bars: oneWordStreakBars }, "limit-up-streak"),
    ).toBeUndefined();
  });

  it("detects a weak-to-strong reclaim above MA10", () => {
    const hit = expectCausal("weak-to-strong", weakToStrongBars);
    expect(hit!.pivotPrice).toBeCloseTo(11.9);
    expect(hit!.stopPrice).toBeCloseTo(11.05);
  });

  it("rejects weak-to-strong without next-day volume confirmation", () => {
    const quiet = weakToStrongBars.map((bar, i) =>
      i === weakToStrongBars.length - 1 ? { ...bar, volume: 100 } : bar,
    );
    expect(find({ bars: quiet }, "weak-to-strong")).toBeUndefined();
  });

  it("detects the dragon first yin on shrinking volume", () => {
    const hit = expectCausal("dragon-first-yin", firstYinBars);
    expect(hit!.pivotPrice).toBeCloseTo(14.6);
    expect(hit!.stopPrice).toBeLessThan(hit!.close);
  });

  it("rejects the first yin when volume does not contract", () => {
    const heavy = firstYinBars.map((bar, i) =>
      i === firstYinBars.length - 1 ? { ...bar, volume: 200 } : bar,
    );
    expect(find({ bars: heavy }, "dragon-first-yin")).toBeUndefined();
  });

  it("detects a bullish reclaim cannon (阳包阴)", () => {
    const hit = expectCausal("bullish-reclaim-cannon", reclaimBars);
    expect(hit!.pivotPrice).toBeCloseTo(10.65);
    expect(hit!.targetPrice).toBeCloseTo(12.1);
  });

  it("rejects a reclaim when the middle bar is not a pullback", () => {
    const noPullback = reclaimBars.map((bar, i) =>
      i === 25 ? { ...bar, open: 10.3, close: 10.4, low: 10.25 } : bar,
    );
    expect(
      find({ bars: noPullback }, "bullish-reclaim-cannon"),
    ).toBeUndefined();
  });

  it("detects a second-wave launch after a contracted pullback", () => {
    const hit = expectCausal("dragon-second-wave", secondWaveBars);
    expect(hit!.pivotPrice).toBeCloseTo(27.01);
    expect(hit!.stopPrice).toBeCloseTo(26.15);
    expect(hit!.targetPrice).toBeCloseTo(32);
  });

  it("rejects the second wave without volume contraction or launch volume", () => {
    expect(
      find({ bars: looseVolumeBars }, "dragon-second-wave"),
    ).toBeUndefined();
    expect(
      find({ bars: thinLaunchBars }, "dragon-second-wave"),
    ).toBeUndefined();
  });
});
