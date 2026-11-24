import { describe, expect, it } from "vitest";
import {
  createExtendedStudyRule,
  prepareStrategy,
  strategyObjectSchema,
  studyStrategies,
  studyWarmup,
  wyckoffExitStudyBindings,
  volumeStudyBindings,
  wyckoffStudyBindings,
} from "trading-strategies";
import { resolve } from "node:path";
import { parseArgs } from "../../../scripts/backtest-diagnose";
import { CORE_12_SYMBOLS } from "../../../scripts/lib/backtest-diagnose/universe-presets";
import { GROWTH_PIT_STRATEGY_KEYS } from "../../../scripts/lib/backtest-diagnose/growth-pit";
import { usesNativeChan } from "~/server/research/lab-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  NATIVE_STRATEGY_KEYS,
  DIAGNOSE_BOOK_PRESETS,
  PIT_STRATEGY_KEYS,
  SIGNAL_STRATEGY_KEYS,
  STUDY_STRATEGY_KEYS,
  buildStrategy,
  isStrategyKey,
  planDiagnoseCells,
  warmupBarsFor,
} from "../../../scripts/lib/backtest-diagnose/strategy-specs";

type CatalogStudy = (typeof studyStrategies)[number];

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

/**
 * Independent copy of the execution probe: a catalog id is a diagnostic signal
 * key only when its rule can be built from a valid synthetic series. Rule
 * construction failures are collected so a probe regression fails loudly
 * instead of silently shrinking the accepted set.
 */
const studyProbe: Bar[] = (() => {
  let state = 20240101;
  const random = () =>
    (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  let close = 30;
  return Array.from({ length: 400 }, (_, index) => {
    const open = close;
    close = Math.max(1, open * (1 + (random() - 0.5) * 0.06));
    const high = Math.max(open, close) * (1 + random() * 0.02);
    const low = Math.min(open, close) * (1 - random() * 0.02);
    const volume = Math.round(1000 * (0.6 + random() * 1.8));
    return {
      date: new Date(Date.UTC(2016, 0, 1 + index)).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume,
      amount: close * volume,
    };
  });
})();

const probeErrors: string[] = [];
const acceptedStudyKeys: CatalogStudy[] = studyStrategies
  .map((id) => {
    try {
      return { id, rule: createExtendedStudyRule(id, studyProbe) };
    } catch {
      probeErrors.push(id);
      return { id, rule: null };
    }
  })
  .filter(({ id, rule }) => id !== "hold" && rule !== null)
  .map(({ id }) => id);

/** The 9 volume + 6 Wyckoff ids that predate the catalog-driven expansion. */
const researchStudyKeys = [
  ...Object.keys(volumeStudyBindings),
  ...Object.keys(wyckoffStudyBindings),
] as CatalogStudy[];

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

    it.each(researchStudyKeys)(
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

it("accepts exactly the executable catalog studies as signal keys", () => {
  expect(probeErrors).toEqual([]);
  expect(acceptedStudyKeys).toHaveLength(98);
  expect([...STUDY_STRATEGY_KEYS]).toEqual(acceptedStudyKeys);
  expect(new Set(STUDY_STRATEGY_KEYS).size).toBe(STUDY_STRATEGY_KEYS.length);
  expect([...acceptedStudyKeys]).toEqual(
    expect.arrayContaining([
      ...Object.keys(volumeStudyBindings),
      ...Object.keys(wyckoffStudyBindings),
      ...Object.keys(wyckoffExitStudyBindings),
      "wy-trend-pullback-confirm-vol10-diagnostic",
    ]),
  );
});

it("registers strict PIT CANSLIM separately from the price-only growth study", () => {
  const key = "research-canslim-pit";
  expect(PIT_STRATEGY_KEYS).toContain(key);
  expect(SIGNAL_STRATEGY_KEYS).toContain(key);
  expect(isStrategyKey(key)).toBe(true);
  expect(STUDY_STRATEGY_KEYS).not.toContain(key);
  expect(STUDY_STRATEGY_KEYS).toContain("research-growth");
  expect(warmupBarsFor(key)).toBe(300);

  const strategy = buildStrategy(key, [symbol], "single");
  expect(strategy.entry).toEqual({
    kind: "external",
    id: key,
    side: "entry",
  });
  expect(strategy.exit).toEqual({
    rule: { kind: "study-rule", strategy: "research-growth", side: "exit" },
  });
});

it("plans research-chan as a native signal strategy outside the study catalog", () => {
  expect(NATIVE_STRATEGY_KEYS).toContain("research-chan");
  expect(SIGNAL_STRATEGY_KEYS).toContain("research-chan");
  expect(isStrategyKey("research-chan")).toBe(true);
  expect(STUDY_STRATEGY_KEYS).not.toContain("research-chan");
  expect(warmupBarsFor("research-chan")).toBe(140);
  const strategy = strategyObjectSchema.parse(
    buildStrategy("research-chan", [symbol], "single"),
  );
  expect(strategy.entry).toEqual({ kind: "chan-third-buy", firstIndex: 140 });
  expect(strategy.exit).toEqual({ maxBars: 5 });
  expect(
    planDiagnoseCells({
      symbols: [symbol],
      strategies: ["research-chan"],
      controls: [],
      mode: "per-symbol",
    }),
  ).toEqual([
    { mode: "per-symbol", strategy: "research-chan", symbols: [symbol] },
  ]);
});

describe.each(["single", "portfolio"] as const)(
  "%s accepted study capability",
  (mode) => {
    it.each(STUDY_STRATEGY_KEYS)(
      "%s builds as a study signal and prepares without throwing",
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
        expect(() =>
          prepareStrategy(strategy, bars).evaluate(bars.length - 1),
        ).not.toThrow();
      },
    );
  },
);

it.each(researchStudyKeys)("%s warms up 140 bars", (key) => {
  expect(warmupBarsFor(key)).toBe(140);
});

it("keeps hold as the ledger control rather than a study signal", () => {
  expect(warmupBarsFor("hold")).toBe(0);
  expect(STUDY_STRATEGY_KEYS).not.toContain("hold");
  expect(buildStrategy("hold", [symbol], "single").entry).toMatchObject({
    kind: "constant",
    value: true,
  });
});

it("keeps strategy key planning stable for the expanded catalog", () => {
  expect(isStrategyKey("hold")).toBe(true);
  expect(isStrategyKey("theory-squeeze")).toBe(true);
  expect(isStrategyKey("ma")).toBe(false);
  expect(() =>
    planDiagnoseCells({
      symbols: [symbol],
      strategies: ["not-a-strategy"],
      controls: [],
      mode: "per-symbol",
    }),
  ).toThrow("未知诊断策略：not-a-strategy");
  expect(
    planDiagnoseCells({
      symbols: [symbol],
      strategies: ["theory-squeeze"],
      controls: ["hold"],
      mode: "portfolio",
    }),
  ).toEqual([
    { mode: "portfolio", strategy: "theory-squeeze", symbols: [symbol] },
    { mode: "portfolio", strategy: "hold", symbols: [symbol] },
  ]);
  expect(() =>
    planDiagnoseCells({
      symbols: [symbol],
      strategies: ["theory-squeeze", "theory-squeeze"],
      controls: [],
      mode: "per-symbol",
    }),
  ).toThrow("诊断策略重复");
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

it.each(researchStudyKeys)(
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

it.each([
  ["research-chan-first", "chan-first-native"],
  ["research-chan-second", "chan-second-native"],
  ["research-chan-third", "chan-third-native"],
  ["research-chan-hold-cash", "chan-hold-cash-native"],
] as const)(
  "%s uses its native profile and the designated exit",
  (key, profile) => {
    expect(SIGNAL_STRATEGY_KEYS).toContain(key);
    expect(warmupBarsFor(key)).toBe(140);
    const s = buildStrategy(key, [symbol], "single");
    expect(usesNativeChan(s)).toBe(true);
    expect(s.entry).toEqual({ kind: "chan-native", profile, side: "entry" });
    if (key === "research-chan-hold-cash") {
      expect(s.exit).toEqual({
        rule: { kind: "chan-native", profile, side: "exit" },
      });
      expect(
        usesNativeChan({ ...s, entry: { kind: "constant", value: true } }),
      ).toBe(true);
    } else expect(s.exit).toEqual({ maxBars: 5 });
  },
);

it.each(GROWTH_PIT_STRATEGY_KEYS)(
  "%s registers the PIT entry and its exact exit",
  (key) => {
    expect(SIGNAL_STRATEGY_KEYS).toContain(key);
    expect(warmupBarsFor(key)).toBe(
      key.startsWith("research-sepa-vcp-close")
        ? studyWarmup("theory-vcp-close")
        : 300,
    );
    const strategy = buildStrategy(key, [symbol], "single");
    expect(strategy.entry).toEqual({
      kind: "external",
      id: key,
      side: "entry",
    });
    if (key.endsWith("stop8") || key.endsWith("stop7"))
      expect(strategy.exit).toEqual({
        stop: { kind: "fixed", fraction: key.endsWith("stop8") ? 0.08 : 0.07 },
      });
    else if (key.endsWith("ma20") || key.endsWith("ma50"))
      expect(strategy.exit).toEqual({
        rule: { kind: "external", id: key, side: "exit" },
      });
    else if (key.startsWith("research-sepa"))
      expect(strategy.exit).toEqual({ maxBars: 6 });
    else
      expect(strategy.exit).toEqual({
        rule: { kind: "study-rule", strategy: "research-growth", side: "exit" },
      });
  },
);

it("plans core-12 and rejects competing symbol inputs in either order", () => {
  const base = ["--tdx-root", resolve("fixture")];
  const plan = parseArgs([
    ...base,
    "--pool",
    "core-12",
    "--strategies",
    "research-sepa-pit,research-canslim-pit-m,research-chan-hold-cash",
    "--plan",
  ]);
  expect(plan.symbols).toEqual(CORE_12_SYMBOLS);
  expect(planDiagnoseCells(plan)).toHaveLength(52);
  expect(parseArgs([...base, "--pool", "chan-core-7"]).symbols).toHaveLength(7);
  expect(parseArgs([...base, "--pool", "core-5"]).symbols).toEqual(
    parseArgs(base).symbols,
  );
  for (const args of [
    ["--pool", "core-12", "--symbols", symbol],
    ["--symbols", symbol, "--pool", "core-5"],
  ])
    expect(() => parseArgs([...base, ...args])).toThrow(/--pool.*--symbols/);
});

it("plans core-4 as one portfolio and opts into historical holdout independently", () => {
  const base = ["--tdx-root", resolve("fixture"), "--symbols", symbol];
  const args = parseArgs([...base, "--book", "core-4", "--holdout"]);
  expect(planDiagnoseCells(args)).toEqual([
    { strategy: "core-4", mode: "portfolio", symbols: [symbol] },
  ]);
  expect(args.holdoutStart).toBe("2023-01-01");
  expect(parseArgs(base).holdoutStart).toBeUndefined();
  expect(
    parseArgs([...base, "--holdout-start", "2024-02-29"]).holdoutStart,
  ).toBe("2024-02-29");
  for (const bad of ["2023-02-29", "2023-1-01", "x"])
    expect(() => parseArgs([...base, "--holdout-start", bad])).toThrow(
      "--holdout-start",
    );
  for (const extra of [
    ["--strategies", "hold"],
    ["--mode", "both"],
  ])
    expect(() => parseArgs([...base, "--book", "core-4", ...extra])).toThrow(
      "--book",
    );
  const book = DIAGNOSE_BOOK_PRESETS["core-4"];
  expect(book.sleeves.map((s) => s.strategyKey)).toEqual([
    "research-chan-hold-cash",
    "research-canslim-pit-ma50",
    "theory-vcp-close",
    "classic-ibs",
  ]);
  expect(book.sleeves.map((s) => s.share)).toEqual([0.25, 0.25, 0.25, 0.25]);
  expect(book).toMatchObject({
    accountMaxUniqueSymbols: 10,
    accountMaxSymbolWeight: 0.1,
  });
});

it("registers the three SEPA close variants and binds CH14 structure stop to the causal ZD field", () => {
  for (const suffix of ["price", "pit", "pit-strict-finance"])
    expect(PIT_STRATEGY_KEYS).toContain(`research-sepa-vcp-close-${suffix}`);
  const key = "research-chan-hold-cash-zd-stop";
  expect(NATIVE_STRATEGY_KEYS).toContain(key);
  expect(buildStrategy(key, [symbol], "single")).toMatchObject({
    entry: { kind: "chan-native", profile: "chan-hold-cash-native" },
    exit: { stop: { kind: "structure", field: "chan-zd" } },
  });
});
