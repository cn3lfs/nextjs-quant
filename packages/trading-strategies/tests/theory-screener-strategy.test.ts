import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  composeLongOnlyStrategies,
  evaluateDowDualIndex,
  evaluateOneilMarketDirection,
  evaluateStrategyBook,
  listTheoryScreenerSpecs,
  prepareStrategy,
  prepareTheoryScreeners,
  strategyObjectSchema,
  theoryScreenerFamilyIds,
  type StrategyObjectInput,
  type TheoryScreenerFamilyId,
} from "../src/index.js";

const base = {
  id: "wave-1",
  version: 1,
  market: "cn-equity",
  period: "day",
  sleeve: "test",
  universe: { kind: "symbols", symbols: ["sh600001"] },
  entry: { kind: "constant", value: true },
  exit: {},
  sizing: { kind: "equal", positions: 1 },
} satisfies StrategyObjectInput;
type TheoryRule = Extract<
  StrategyObjectInput["entry"],
  { kind: "theory-screener" }
>;
function strategyFor(
  methodId: string,
  options: Partial<Omit<TheoryRule, "methodId" | "kind" | "side">> = {},
): StrategyObjectInput {
  const rule = { kind: "theory-screener", methodId, ...options } as const;
  return {
    ...base,
    entry: { ...rule, side: "entry" },
    exit: { rule: { ...rule, side: "exit" } },
  };
}
function candle(
  i: number,
  close = 100,
  volume = 100,
  overrides: Partial<Bar> = {},
): Bar {
  return {
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    open: close,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume,
    amount: close * volume,
    ...overrides,
  };
}
function history(length: number, make: (i: number) => Bar) {
  return Array.from({ length }, (_, i) => make(i));
}
const wyckoffBars = history(81, (i) =>
  i === 80
    ? candle(i, 107, 160, { open: 103, high: 108, low: 102 })
    : candle(i, 100, 100, { high: 105, low: 95 }),
);
const fixture: Record<TheoryScreenerFamilyId, [string, Bar[]]> = {
  "trend-breakout": ["f04-turtle-donchian", wyckoffBars],
  "wyckoff-volume": ["f08-wyckoff-sos-jac", wyckoffBars],
  "wave-harmonic-smc": [
    "f05-key-candlestick-reversal",
    history(81, (i) =>
      i === 79
        ? candle(i, 100.8, 100, { open: 100, high: 101, low: 95 })
        : i === 80
          ? candle(i, 104, 150, { open: 101, high: 105, low: 100 })
          : candle(i, 100, 100, { high: 101, low: 99 }),
    ),
  ],
  "astock-dragon": [
    "f11-first-limit-up-break",
    history(41, (i) => candle(i, i === 40 ? 11 : 10, i === 40 ? 200 : 100)),
  ],
  "growth-oneil": [
    "f09-sepa-trend-template",
    history(250, (i) =>
      candle(i, i === 249 ? 102 : 40 + (59 * i) / 248, i === 249 ? 230 : 100),
    ),
  ],
  "momentum-reversion": [
    "f10-rps-triple-red",
    history(131, (i) =>
      candle(
        i,
        i === 130 ? 20 : i > 120 ? 18 + (i - 120) / 9 : 10 + (8 * i) / 120,
        i === 130 ? 200 : 100,
      ),
    ),
  ],
  "value-multifactor": [
    "f13-graham-value-shield",
    history(81, (i) => candle(i, i === 80 ? 102 : i === 79 ? 99 : 100)),
  ],
};

it("accepts long-capable registered methods and rejects short-only and unknown IDs before scanning", () => {
  const specs = listTheoryScreenerSpecs();
  expect(new Set(specs.map((s) => s.id)).size).toBe(57);
  for (const spec of specs) {
    if (spec.direction === "short") {
      expect(() => prepareStrategy(strategyFor(spec.id), [])).toThrow(
        `Long-only strategy rules cannot run short-only screeners: ${spec.id}`,
      );
      continue;
    }
    expect(strategyObjectSchema.parse(strategyFor(spec.id)).entry).toEqual({
      kind: "theory-screener",
      methodId: spec.id,
      direction: "long",
      holdBars: 25,
      useScreenerStops: true,
      side: "entry",
    });
  }
  expect(() => prepareStrategy(strategyFor("missing-method"), [])).toThrow(
    /Unknown theory screener methodId: missing-method/,
  );
});
it.each(["short", "both"])(
  "rejects %s direction on a long-only strategy rule",
  (direction) => {
    const entry = {
      kind: "theory-screener",
      methodId: "f04-turtle-donchian",
      side: "entry",
      direction,
    };
    expect(strategyObjectSchema.safeParse({ ...base, entry }).success).toBe(
      false,
    );
  },
);
it.each(theoryScreenerFamilyIds)(
  "%s real entry, evidence and registry matches are invariant to future extremes",
  (family) => {
    const [id, prefix] = fixture[family],
      t = prefix.length - 1;
    const bars = [
      ...prefix,
      ...history(8, (i) => candle(t + 1 + i, i % 2 ? 12 : 230, 900)),
    ];
    const filter = { families: [family] };
    const full = prepareTheoryScreeners({ bars }, filter);
    const object = strategyFor(id),
      compiled = prepareStrategy(object, bars);
    for (const i of [t - 3, t - 1, t, t + 1, t + 3]) {
      const past = bars.slice(0, i + 1);
      const expected = prepareTheoryScreeners({ bars: past }, filter).at(i);
      expect(full.at(i)).toEqual(expected);
      const short = prepareStrategy(object, past);
      expect(compiled.evaluate(i)).toEqual(short.evaluate(i));
      expect(compiled.explain(i)).toEqual(short.explain(i));
      if (i === t) {
        const match = expected.find((m) => m.methodId === id);
        expect(match).toBeDefined();
        expect(compiled.evaluate(i)).toMatchObject({
          entry: true,
          stopLevel: null,
        });
        expect(compiled.explain(i).inputs.match).toEqual(match);
      }
    }
  },
);
it("uses warmup and score cutoffs, and keeps an explicit entry stop", () => {
  const [id, bars] = fixture["value-multifactor"],
    t = bars.length - 1;
  const strategy = strategyFor(id, { minScore: 3 });
  expect(prepareStrategy(strategy, bars).evaluate(10).entry).toBeNull();
  expect(
    prepareStrategy(strategyFor(id, { minScore: 4 }), bars).evaluate(t).entry,
  ).toBe(false);
  expect(
    prepareStrategy(
      {
        ...strategy,
        exit: { ...strategy.exit, stop: { kind: "fixed", fraction: 0.5 } },
      },
      bars,
    ).evaluate(t).stopLevel,
  ).toBe(51);
});
it("uses the frozen long signal's close-only stop and target, including equality", () => {
  const id = "f08-wyckoff-sos-jac",
    prefix = wyckoffBars;
  const stop = 100,
    target = 120,
    entry = prefix[80]!.close;
  const bars = [
    ...prefix,
    candle(81, entry),
    candle(82, entry, 100, {
      low: Math.min(target, stop) - 1,
      high: Math.max(target, stop) + 1,
    }),
    candle(83, stop),
    candle(84, target),
    candle(85, entry),
  ];
  const prepared = prepareStrategy(strategyFor(id, { holdBars: 4 }), bars);
  expect(prepared.evaluate(80)).toMatchObject({
    entry: true,
    stopLevel: null,
  });
  expect(prepared.explain(80).inputs.match).toMatchObject({
    stopPrice: stop,
    targetPrice: target,
  });
  const position = { entry, entryIndex: 81 };
  expect(prepared.evaluate(82, position).exit).toBe(false);
  expect(prepared.evaluate(83, position).exit).toBe(true);
  expect(
    prepared.evaluate(84, { entry, entryIndex: 82, signalIndex: 80 }).exit,
  ).toBe(true);
  expect(
    prepared.evaluate(84, { entry, entryIndex: 82, signalIndex: 83 }).exit,
  ).toBe(false);
  const timed = prepareStrategy(
    strategyFor(id, { holdBars: 4, useScreenerStops: false }),
    bars,
  );
  expect(timed.evaluate(80).stopLevel).toBeNull();
  expect(timed.evaluate(83, position).exit).toBe(false);
  expect(timed.evaluate(84, position).exit).toBe(false);
  expect(timed.evaluate(85, position).exit).toBe(true);
});

it.each([{ volume: 0 }, { low: 150 }, { close: NaN }])(
  "returns unknown for an invalid observation after warmup (%o)",
  (invalid) => {
    const bars = [...wyckoffBars, candle(81, 107, 100, invalid)];
    const prepared = prepareStrategy(strategyFor("f08-wyckoff-sos-jac"), bars);
    expect(prepared.evaluate(80).entry).toBe(true);
    expect(prepared.evaluate(81).entry).toBeNull();
  },
);

// First advance at 1, follow-through exactly on day four. Distribution
// events at 5 and 7; the former drops out of a four-return window on 9.
const rally = [98, 99, 100, 100, 101.25, 100, 101, 99, 100, 101, 98].map(
  (v, i) =>
    candle(i, v, [90, 100, 100, 100, 110, 120, 90, 120, 100, 100, 130][i]),
);
const oneil = {
  distributionWindow: 4,
  pressureThreshold: 2,
  correctionThreshold: 3,
  pressureScale: 0.4,
};
it("counts the first follow-through once and expires distribution days at the rolling boundary", () => {
  const at = (index: number) =>
    evaluateOneilMarketDirection(rally, { ...oneil, index });
  expect(at(3)).toMatchObject({
    status: "unknown",
    scale: null,
    distributionDays: null,
  });
  expect(at(4)).toEqual({
    status: "confirmed-uptrend",
    scale: 1,
    rallyDay: 4,
    distributionDays: 0,
    followThroughDate: rally[4]!.date,
  });
  expect(at(7)).toMatchObject({
    status: "uptrend-under-pressure",
    scale: 0.4,
    distributionDays: 2,
    followThroughDate: rally[4]!.date,
  });
  expect(at(9)).toMatchObject({
    status: "confirmed-uptrend",
    scale: 1,
    distributionDays: 1,
  });
  expect(evaluateOneilMarketDirection(rally.slice(0, 8), oneil)).toEqual(at(7));
  expect(
    evaluateOneilMarketDirection(rally.slice(0, 8), {
      ...oneil,
      correctionThreshold: 2,
      pressureThreshold: 1,
    }),
  ).toMatchObject({ status: "correction", scale: 0, followThroughDate: null });
  const undercut = [...rally.slice(0, 5), candle(5, 96)];
  expect(evaluateOneilMarketDirection(undercut, oneil)).toMatchObject({
    status: "correction",
    rallyDay: null,
  });
  expect(
    evaluateOneilMarketDirection(
      [...rally.slice(0, 4), candle(4, 101.25, 100)],
      oneil,
    ),
  ).toMatchObject({ status: "correction", followThroughDate: null });
  expect(
    evaluateOneilMarketDirection([...rally, candle(11, 100, 0)], oneil).status,
  ).toBe("unknown");
});
const up = [10, 11, 14, 12, 9, 11, 15, 13, 10, 12, 13].map((c, i) =>
  candle(i, c),
);
const down = up.map((b, i) => candle(i, 30 - b.close));
it.each(["clock", "feed"] as const)(
  "excludes a forming follow-through or distribution day using the %s",
  (source) => {
    for (const index of [4, 5]) {
      const prefix = rally.slice(0, index + 1);
      const date = prefix.at(-1)!.date;
      const gate = { ...oneil, distributionWindow: 3 };
      const filter =
        source === "clock"
          ? { now: Date.parse(`${date}T14:59:00+08:00`) }
          : { formingDates: [date] };
      const completed = evaluateOneilMarketDirection(prefix.slice(0, -1), gate);
      expect(
        evaluateOneilMarketDirection(prefix, { ...gate, ...filter }),
      ).toEqual(completed);
      const afterClose = evaluateOneilMarketDirection(prefix, {
        ...gate,
        now: Date.parse(`${date}T15:05:00+08:00`),
      });
      if (index === 4) {
        expect(completed.followThroughDate).toBeNull();
        expect(afterClose.followThroughDate).toBe(date);
      } else {
        expect(completed.distributionDays).toBe(0);
        expect(afterClose.distributionDays).toBe(1);
      }
    }
  },
);
it("ignores both series' future suffixes for date and primary-index cutoffs", () => {
  const last = up.length - 1,
    date = up[last]!.date;
  const extended = [
    ...up,
    candle(last + 1),
    candle(last + 2, 10, 100, { date: "" }),
  ];
  for (const cutoff of [{ asOf: date }, { index: last }]) {
    expect(
      evaluateDowDualIndex(extended, extended, { swingBars: 2, ...cutoff }),
    ).toEqual({
      status: "confirmed-up",
      scale: 1,
    });
  }
  for (const filter of [
    { now: Date.parse(`${date}T14:59:00+08:00`) },
    { formingDates: [date] },
  ])
    expect(evaluateDowDualIndex(up, up, { swingBars: 2, ...filter })).toEqual({
      status: "unknown",
      scale: null,
    });
});
it("confirms both Dow swing pairs on pivot+k and waits on disagreement", () => {
  const opts = { swingBars: 2 };
  expect(evaluateDowDualIndex(up, up, { ...opts, index: 9 })).toEqual({
    status: "unknown",
    scale: null,
  });
  expect(evaluateDowDualIndex(up, up, opts)).toEqual({
    status: "confirmed-up",
    scale: 1,
  });
  expect(evaluateDowDualIndex(down, down, opts)).toEqual({
    status: "confirmed-down",
    scale: 0,
  });
  expect(evaluateDowDualIndex(up, down, opts)).toEqual({
    status: "wait",
    scale: 0.5,
  });
  expect(evaluateDowDualIndex([...up, candle(11, 1)], up, opts)).toEqual({
    status: "confirmed-up",
    scale: 1,
  });
  expect(
    evaluateDowDualIndex(
      up,
      up.filter((_, i) => i !== 3),
      opts,
    ).status,
  ).toBe("unknown");
  expect(
    evaluateDowDualIndex(up, down, { ...opts, asOf: up[9]!.date }),
  ).toEqual(evaluateDowDualIndex(up.slice(0, 10), down.slice(0, 10), opts));
});
it("removes each exiting strategy's contribution, then caps symbols before proportional scaling", () => {
  const result = composeLongOnlyStrategies({
    maxSymbolWeight: 0.3,
    maxTotalExposure: 0.35,
    strategies: [
      {
        id: "a",
        gateWeight: 0.5,
        targets: { A: 0.8, B: 0.2 },
        exits: ["B", "C"],
      },
      { id: "b", gateWeight: 0.5, targets: { B: 0.4, D: 0.4 }, exits: [] },
    ],
  });
  // Raw A=.4, B=.2, D=.2; capped sum=.7, exposure factor=.5.
  expect(result).toEqual({
    status: "ok",
    weights: { A: 0.15, B: 0.1, D: 0.1 },
    forcedExits: ["C"],
    totalExposure: 0.35,
    scaleApplied: 0.5,
  });
});
it("withholds unknown targets while retaining independent exits and unaffected known targets", () => {
  const caps = { maxSymbolWeight: 1, maxTotalExposure: 1 };
  const known = {
    id: "known",
    gateWeight: 0.5,
    targets: { A: 0.5, B: 0.2 },
    exits: [],
  };
  const missing = {
    id: "missing",
    gateWeight: 0.5,
    targets: null,
    exits: ["A", "C"],
  };
  expect(
    composeLongOnlyStrategies({ ...caps, strategies: [known, missing] }),
  ).toEqual({
    status: "unknown",
    weights: {},
    forcedExits: ["A", "C"],
    totalExposure: null,
    scaleApplied: null,
  });
  expect(
    composeLongOnlyStrategies({
      ...caps,
      strategies: [known, { ...missing, gateWeight: NaN, targets: { B: 0.5 } }],
    }),
  ).toMatchObject({
    status: "partial",
    weights: { A: 0.25 },
    forcedExits: ["C"],
  });
  expect(
    composeLongOnlyStrategies({
      ...caps,
      strategies: [known, { ...missing, targets: {}, gateWeight: 0.6 }],
    }),
  ).toMatchObject({
    status: "unknown",
    weights: {},
    forcedExits: ["A", "C"],
    totalExposure: null,
    scaleApplied: null,
  });
  expect(
    composeLongOnlyStrategies({
      ...caps,
      strategies: [known, { ...missing, gateWeight: 0 }],
    }),
  ).toMatchObject({ weights: { A: 0.25, B: 0.1 }, forcedExits: ["C"] });
});
it.each([NaN, null])(
  "preserves a gated-off exit when %s invalidates another sleeve's positive target",
  (invalid) => {
    const result = composeLongOnlyStrategies({
      strategies: [
        { id: "exit", gateWeight: 0, targets: null, exits: ["A"] },
        { id: "buy", gateWeight: 0.5, targets: { A: 0.4 }, exits: [] },
        { id: "missing", gateWeight: 0.5, targets: { A: invalid }, exits: [] },
      ],
      maxSymbolWeight: 1,
      maxTotalExposure: 1,
    });
    expect(result).toEqual({
      status: "unknown",
      weights: {},
      forcedExits: ["A"],
      totalExposure: null,
      scaleApplied: null,
    });
  },
);
function book(
  regime: NonNullable<StrategyObjectInput["regime"]>,
  benchmark: Bar[],
  i: number,
  secondary?: Bar[],
) {
  return evaluateStrategyBook(strategyObjectSchema.parse({ ...base, regime }), {
    date: benchmark[i]!.date,
    calendar: benchmark.map((b) => b.date),
    initial: 100,
    equity: 100,
    maxPositions: 1,
    candidates: [
      {
        symbol: "A",
        bars: benchmark,
        decision: { entry: true, exit: false, stopLevel: null },
      },
    ],
    facts: {
      benchmark: { symbol: "index", bars: benchmark },
      secondaryBenchmarkBars: secondary,
    },
  });
}
it("applies O'Neil and Dow gate scales to book entries and fails closed without aligned facts", () => {
  const o = {
    kind: "oneil-market-direction",
    benchmark: "index",
    ...oneil,
  } as const;
  expect(book(o, rally, 7)).toMatchObject({
    available: true,
    regime: { status: "uptrend-under-pressure" },
    entries: [{ weight: 0.4 }],
  });
  expect(book(o, rally, 3)).toMatchObject({
    available: false,
    entries: [],
    regime: { status: "unknown" },
  });
  const d = {
    kind: "dow-dual-index",
    benchmark: "index",
    secondaryBenchmark: "second",
    swingBars: 2,
    waitScale: 0.35,
  } as const;
  expect(book(d, up, 10, down)).toMatchObject({
    available: true,
    regime: { status: "wait" },
    entries: [{ weight: 0.35 }],
  });
  expect(book(d, down, 10, down)).toMatchObject({
    available: true,
    entryAdmissionScale: 0,
    entries: [],
  });
  expect(book(d, up, 10, up.slice(0, 10))).toMatchObject({
    available: false,
    entries: [],
    regime: { status: "unknown" },
  });
  expect(book(d, up, 10)).toMatchObject({ available: false, entries: [] });
});
