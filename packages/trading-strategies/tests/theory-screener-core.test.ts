import { expect, it, vi } from "vitest";
import {
  astockPriceLimitRatio,
  causalAlternatingPivots,
  clampScore,
  computeRewardMultiple,
  createRuleFromTheoryScreener,
  isAstockLimitUp,
  isValidBarRange,
  isValidOhlcvBar,
  listTheoryScreenerSpecs,
  makeGeometryLine,
  meanVolume,
  prepareTheoryScreeners,
  priorVolumeRatio,
  registerTheoryFamilyScreener,
  type TheoryScreenMatch,
  type TheoryScreenerMethodSpec,
} from "../src/screener/index.js";

const bars = Array.from({ length: 35 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 10,
  high: 12,
  low: 8,
  close: 10,
  volume: i + 1,
  amount: 100,
}));

it("uses complete inclusive ranges and excludes the signal volume from its baseline", () => {
  expect(isValidOhlcvBar(null)).toBe(false);
  expect(isValidOhlcvBar({ ...bars[0]!, low: 11 })).toBe(false);
  expect(isValidBarRange(bars, 0, 1)).toBe(true);
  expect(isValidBarRange(bars, 0, bars.length)).toBe(false);
  expect(meanVolume(bars, 0, 1)).toBe(1.5);
  expect(priorVolumeRatio(bars, 2, 2)).toBe(2);
  expect(priorVolumeRatio(bars, 2)).toBeNull();
  expect([0, 2.6, 9, NaN].map(clampScore)).toEqual([1, 3, 5, 1]);
  expect(
    makeGeometryLine(bars, "edge", "upper", "solid", [
      { index: 1, price: 12 },
      ...[-1, 0.5, bars.length].map((index) => ({ index, price: 10 })),
      { index: 0, price: NaN },
    ]),
  ).toEqual({
    label: "edge",
    kind: "upper",
    style: "solid",
    points: [{ index: 1, date: bars[1]!.date, price: 12 }],
  });
});

it("discards unconfirmed, too recent and stale pivots before merging adjacent highs and lows", () => {
  const pivot = (
    index: number,
    kind: "high" | "low",
    price: number,
    confirmed = index + 3,
  ) => ({
    index,
    kind,
    price,
    date: bars[index]!.date,
    confirmedAt: bars[confirmed]!.date,
  });
  const invalid = bars.map((bar, i) => (i === 4 ? { ...bar, volume: 0 } : bar));
  expect(
    causalAlternatingPivots(
      [pivot(4, "low", 7), pivot(7, "high", 13)],
      invalid,
      10,
    ),
  ).toEqual([]);
  const pivots = [
    pivot(0, "low", 5),
    pivot(1, "high", 11),
    pivot(2, "high", 12),
    pivot(3, "low", 8),
    pivot(4, "low", 7),
    pivot(5, "high", 13, 11),
    pivot(8, "high", 14, 10),
  ];
  expect(causalAlternatingPivots(pivots, bars, 10, 9)).toEqual([
    pivots[2],
    pivots[4],
  ]);
});

it("requires positive risk and reward on the appropriate side", () => {
  expect(computeRewardMultiple("long", 10, 9, 13)).toBe(3);
  expect(computeRewardMultiple("short", 10, 12, 6)).toBe(2);
  expect(computeRewardMultiple("long", 10, 10, 13)).toBeNull();
  expect(computeRewardMultiple("short", 10, 12, 13)).toBeNull();
  expect(computeRewardMultiple("long", 10, null, 13)).toBeNull();
});

it("uses board-specific rounded limits in integer cents", () => {
  expect(
    ["sh688001", "sz300001", "sz301001", "bj123", "sh600001"].map(
      astockPriceLimitRatio,
    ),
  ).toEqual([0.2, 0.2, 0.2, 0.3, 0.1]);
  expect(isAstockLimitUp(10.06, 12.07, "sz301001")).toBe(true);
  expect(isAstockLimitUp(10.06, 12.06, "sz301001")).toBe(false);
  expect(isAstockLimitUp(1.15, 1.27, "sh600000")).toBe(true);
  expect(isAstockLimitUp(10, 10.99, "sh600000")).toBe(false);
  expect(isAstockLimitUp(0, 0)).toBe(false);
});

it("prepares a family once, filters missing metrics and orders tied scores by reward", () => {
  const family = "trend-breakout";
  const spec: TheoryScreenerMethodSpec = {
    id: "sample",
    theoryId: "T",
    family,
    label: "T",
    direction: "both",
    warmupBars: 0,
    description: "",
  };
  const match: TheoryScreenMatch = {
    family,
    methodId: "sample",
    theoryId: "T",
    label: "T",
    direction: "long",
    index: 0,
    date: bars[0]!.date,
    close: 10,
    pivotPrice: 10,
    stopPrice: 9,
    targetPrice: 13,
    rewardMultiple: 3,
    volumeRatio: 2,
    score: 4,
    summary: "",
    geometry: { lines: [] },
  };
  const factory = vi.fn(() => ({
    specs: [spec],
    at: () => [
      match,
      { ...match, rewardMultiple: 4 },
      { ...match, rewardMultiple: null, volumeRatio: null, score: 5 },
      { ...match, direction: "short" as const },
    ],
  }));
  registerTheoryFamilyScreener(family, factory);
  expect(listTheoryScreenerSpecs()).toContainEqual(spec);
  factory.mockClear();
  const prep = prepareTheoryScreeners(
    { bars },
    {
      families: [family],
      methodIds: ["sample"],
      direction: "long",
      minScore: 4,
      minRewardMultiple: 3,
      minVolumeRatio: 2,
    },
  );
  expect(prep.at(0).map((m) => m.rewardMultiple)).toEqual([4, 3]);
  expect(prep.at(-1)).toEqual([]);
  expect(prepareTheoryScreeners({ bars }, { families: [] }).at(0)).toEqual([]);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(
    prepareTheoryScreeners({ bars })
      .at(0)
      .map((m) => m.score),
  ).toEqual([5, 4, 4, 4]);
  expect(
    prepareTheoryScreeners({ bars }, { methodIds: ["other"] }).at(0),
  ).toEqual([]);
  for (const filter of [
    { minScore: 6 },
    { minVolumeRatio: 3 },
    { minRewardMultiple: 5 },
  ])
    expect(prepareTheoryScreeners({ bars }, filter).at(0)).toEqual([]);

  for (const direction of ["long", "short"] as const) {
    registerTheoryFamilyScreener(family, () => ({
      specs: [spec],
      at: (i) =>
        i === 0
          ? [
              {
                ...match,
                direction,
                stopPrice: direction === "long" ? 9 : 11,
                targetPrice: direction === "long" ? 11 : 9,
              },
            ]
          : [],
    }));
    const history = bars.map((b, i) => ({
      ...b,
      close: i === 4 ? 9 : i === 5 ? 11 : 10,
    }));
    const rule = createRuleFromTheoryScreener("sample", history);
    const position = { entry: 10, entryIndex: 3, signalIndex: 0 };
    expect(rule.entry(0)).toBe(true);
    expect(rule.entry(1)).toBe(false);
    expect(rule.exit(2, position)).toBe(false);
    expect(rule.exit(3, position)).toBe(false);
    expect(rule.exit(4, position)).toBe(true);
    expect(rule.exit(5, position)).toBe(true);
    expect(rule.exit(27, position)).toBe(false);
    const invalid = history.map((bar, index) =>
      index === 4 || index === 28 ? { ...bar, volume: 0 } : bar,
    );
    const blocked = createRuleFromTheoryScreener("sample", invalid);
    expect(blocked.exit(4, position)).toBe(false);
    expect(blocked.exit(28, position)).toBe(false);
    expect(rule.exit(28, position)).toBe(true);
    expect(
      createRuleFromTheoryScreener("sample", history, { holdBars: 3 }).exit(
        6,
        position,
      ),
    ).toBe(true);
  }
});
