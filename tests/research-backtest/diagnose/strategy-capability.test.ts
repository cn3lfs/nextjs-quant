import { describe, expect, it } from "vitest";
import {
  createExtendedStudyRule,
  prepareStrategy,
  strategyObjectSchema,
  volumeStudyBindings,
  wyckoffStudyBindings,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import {
  STUDY_STRATEGY_KEYS,
  buildStrategy,
  warmupBarsFor,
} from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const symbol = "sh600000";
const bars: Bar[] = Array.from({ length: 320 }, (_, index) => {
  const close = index === 319 ? 32 : 30;
  const volume = index === 319 ? 2_000 : 1_000;
  return {
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    open: close,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume,
    amount: close * volume,
  };
});

const cases = [
  { key: "dual-ma", entryKind: "dual-ma", entry: true },
  { key: "turtle", entryKind: "study-rule", entry: true },
  { key: "rsi2", entryKind: "study-rule", entry: false },
  { key: "double-breakout", entryKind: "double-breakout", entry: false },
  { key: "formula", entryKind: "formula", entry: true },
  { key: "hold", entryKind: "constant", entry: true },
] as const;

describe.each(["single", "portfolio"] as const)(
  "%s strategy capability",
  (mode) => {
    it.each(cases)(
      "$key parses and evaluates on 320 valid daily bars",
      ({ key, entryKind, entry }) => {
        const symbols = mode === "single" ? [symbol] : [symbol, "sz000001"];
        const strategy = strategyObjectSchema.parse(
          buildStrategy(key, symbols, mode),
        );
        expect(strategy.entry.kind).toBe(entryKind);
        expect(strategy.universe).toMatchObject({ kind: "symbols", symbols });
        expect(strategy.sizing).toMatchObject(
          mode === "single"
            ? { kind: "weight", weight: 1 }
            : { kind: "equal", positions: 2 },
        );
        const decision = prepareStrategy(strategy, bars).evaluate(
          bars.length - 1,
        );
        // The final close crosses MA5/20, clears 20 prior highs on twice the usual
        // volume, and cannot be an oversold RSI2 entry or a two-line breakout.
        expect(decision.entry).toBe(entry);
      },
    );

    it.each(STUDY_STRATEGY_KEYS)(
      "%s research study parses and evaluates as a signal strategy",
      (key) => {
        const symbols = mode === "single" ? [symbol] : [symbol, "sz000001"];
        const strategy = strategyObjectSchema.parse(
          buildStrategy(key, symbols, mode),
        );
        expect(strategy.id).toBe(`diag-${key}`);
        expect(strategy.entry).toMatchObject({
          kind: "study-rule",
          strategy: key,
          side: "entry",
        });
        expect(strategy.exit).toMatchObject({
          rule: { kind: "study-rule", strategy: key, side: "exit" },
        });
        expect(strategy.universe).toMatchObject({ kind: "symbols", symbols });
        expect(strategy.sizing).toMatchObject(
          mode === "single"
            ? { kind: "weight", weight: 1 }
            : { kind: "equal", positions: 2 },
        );
        // The prepared strategy must evaluate the same study rule, not a
        // short-circuited boolean: compare entry against the catalog rule.
        const prepared = prepareStrategy(strategy, bars);
        const rule = createExtendedStudyRule(key, bars)!;
        for (const index of [bars.length - 1, bars.length - 2, 200]) {
          expect(prepared.evaluate(index).entry).toBe(
            rule(index, { entry: 0, entryIndex: index }).enter,
          );
        }
      },
    );
  },
);

it("accepts exactly the catalog research studies as signal keys", () => {
  expect([...STUDY_STRATEGY_KEYS].sort()).toEqual(
    [
      ...Object.keys(volumeStudyBindings),
      ...Object.keys(wyckoffStudyBindings),
    ].sort(),
  );
  expect(new Set(STUDY_STRATEGY_KEYS).size).toBe(STUDY_STRATEGY_KEYS.length);
});

it.each(STUDY_STRATEGY_KEYS)("%s warms up 140 bars", (key) => {
  expect(warmupBarsFor(key)).toBe(140);
});

it("keeps the hold control at zero warmup", () => {
  expect(warmupBarsFor("hold")).toBe(0);
});

/**
 * One series per structural family. Every study key must enter at least once
 * on this pool; otherwise a prepared strategy that short-circuits entry to
 * false would still match a reference rule that is always false.
 */
const day = (index: number) =>
  new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
const lcg = (seed: number) => {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
};
function walk(seed: number): Bar[] {
  const rand = lcg(seed);
  const rows: Bar[] = [];
  let close = 30;
  for (let index = 0; index < 400; index++) {
    const open = close;
    close = Math.max(1, open * (1 + (rand() - 0.5) * 0.08));
    const high = Math.max(open, close) * (1 + rand() * 0.03);
    const low = Math.min(open, close) * (1 - rand() * 0.03);
    const volume = Math.round(1000 * (0.5 + rand() * 2));
    rows.push({
      date: day(index),
      open,
      high,
      low,
      close,
      volume,
      amount: close * volume,
    });
  }
  return rows;
}
function regime(seed: number, lengths: readonly number[]): Bar[] {
  const rand = lcg(seed);
  const phases = [
    { len: lengths[0]!, drift: -0.004, vol: 1 },
    { len: lengths[1]!, drift: 0.003, vol: 1.6 },
    { len: lengths[2]!, drift: -0.001, vol: 0.6 },
    { len: lengths[3]!, drift: 0.004, vol: 1.4 },
    { len: lengths[4]!, drift: 0, vol: 0.7 },
    { len: lengths[5]!, drift: 0.006, vol: 2 },
  ];
  const rows: Bar[] = [];
  let close = 50;
  let index = 0;
  for (const phase of phases)
    for (let step = 0; step < phase.len; step++, index++) {
      const open = close;
      close = Math.max(1, open * (1 + phase.drift + (rand() - 0.5) * 0.02));
      const high = Math.max(open, close) * (1 + rand() * 0.012);
      const low = Math.min(open, close) * (1 - rand() * 0.012);
      const volume = Math.round(1000 * phase.vol * (0.7 + rand() * 0.6));
      rows.push({
        date: day(index),
        open,
        high,
        low,
        close,
        volume,
        amount: close * volume,
      });
    }
  return rows;
}
function trendSpike(): Bar[] {
  const rows: Bar[] = [];
  for (let index = 0; index < 200; index++) {
    const close = 100 + index * 0.05;
    rows.push({
      date: day(index),
      open: close - 0.1,
      high: close + 0.3,
      low: close - 0.3,
      close,
      volume: 1000,
      amount: close * 1000,
    });
  }
  const last = rows.at(-1)!.close;
  rows.push({
    date: day(200),
    open: last,
    high: last * 1.04,
    low: last * 0.99,
    close: last * 1.035,
    volume: 3000,
    amount: last * 1.035 * 3000,
  });
  return rows;
}
function anchor(): Bar[] {
  const points = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
  ];
  return Array.from({ length: 90 }, (_, index) => {
    const next = points.findIndex((point) => point[0]! >= index);
    const left = points[Math.max(0, next - 1)]!;
    const right = points[next]!;
    const close =
      left[1]! +
      ((right[1]! - left[1]!) * (index - left[0]!)) /
        Math.max(1, right[0]! - left[0]!);
    return {
      date: day(index),
      open: close - 0.1,
      close,
      high: close + 0.5,
      low: close - 0.5,
      volume: 100,
      amount: close * 100,
    };
  });
}
function append(rows: Bar[], row: Partial<Bar>) {
  rows.push({
    date: day(rows.length),
    open: 105,
    close: 105.2,
    high: 105.5,
    low: 104.5,
    volume: 100,
    amount: 10500,
    ...row,
  });
  return rows;
}
function padAt(rows: Bar[], count: number, level: number): Bar[] {
  const start = Date.parse(rows[0]!.date);
  const padding: Bar[] = Array.from({ length: count }, (_, index) => ({
    date: new Date(start - (count - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    open: level,
    high: level + 0.5,
    low: level - 0.5,
    close: level,
    volume: 100,
    amount: level * 100,
  }));
  return [...padding, ...rows];
}
function jac(): Bar[] {
  const rows = append(anchor(), {
    open: 102,
    low: 102,
    high: 106,
    close: 105.5,
    volume: 150,
  });
  return append(rows, { open: 105.2, low: 104.5, high: 105.8, close: 105.6 });
}
function lps(): Bar[] {
  const rows = jac();
  append(rows, {
    open: 105.5,
    close: 105,
    high: 105.6,
    low: 104.5,
    volume: 40,
  });
  return append(rows, {
    open: 105.1,
    close: 105.8,
    high: 106,
    low: 104.8,
    volume: 100,
  });
}
function pullback(): Bar[] {
  const rows: Bar[] = Array.from({ length: 90 }, (_, index) => ({
    date: day(index),
    open: 100 + index * 0.2 - 0.1,
    close: 100 + index * 0.2,
    high: 100 + index * 0.2 + 0.5,
    low: 100 + index * 0.2 - 0.5,
    volume: 100,
    amount: (100 + index * 0.2) * 100,
  }));
  const average = rows.slice(-20).reduce((sum, bar) => sum + bar.close, 0) / 20;
  append(rows, {
    open: 117,
    low: average,
    high: 117.2,
    close: average + 0.3,
    volume: 40,
  });
  append(rows, {
    open: 117,
    low: average + 0.1,
    high: 118,
    close: 117.5,
    volume: 150,
  });
  return rows;
}
const triggerPool: Bar[][] = [
  trendSpike(),
  padAt(jac(), 70, 80),
  padAt(lps(), 70, 80),
  padAt(pullback(), 70, 100),
  walk(1),
  walk(2),
  walk(6),
  regime(21, [70, 45, 35, 45, 30, 30]),
  regime(101, [60, 40, 30, 40, 25, 30]),
];

it.each(STUDY_STRATEGY_KEYS)(
  "%s enters on at least one structural fixture and keeps the rule wired",
  (key) => {
    let hit: { bars: Bar[]; index: number } | null = null;
    for (const poolBars of triggerPool) {
      const rule = createExtendedStudyRule(key, poolBars)!;
      for (let index = 140; index < poolBars.length; index++) {
        if (rule(index, { entry: 0, entryIndex: index }).enter) {
          hit = { bars: poolBars, index };
          break;
        }
      }
      if (hit) break;
    }
    expect(
      hit,
      `${key} has no entry in the structural fixture pool`,
    ).not.toBeNull();
    const strategy = strategyObjectSchema.parse(
      buildStrategy(key, [symbol], "single"),
    );
    expect(
      prepareStrategy(strategy, hit!.bars).evaluate(hit!.index).entry,
    ).toBe(true);
  },
);

it.each(["ma", "breakout"] as const)(
  "rejects account-only study rule %s through prepareStrategy",
  (strategy) => {
    const accountOnly = strategyObjectSchema.parse({
      ...buildStrategy("hold", [symbol], "single"),
      entry: { kind: "study-rule", strategy, side: "entry" },
    });
    expect(() => prepareStrategy(accountOnly, bars)).toThrow(
      /account-only execution profile/i,
    );
  },
);
