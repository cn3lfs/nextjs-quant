import { expect, it } from "vitest";
import {
  strategyObjectSchema,
  nextStrategyProtection,
  strategyReentryAllowed,
  evaluateStrategyBook,
  transferStrategyBook,
  buildClassicSchedule,
  strategyBookReturns,
  csi800ClassicFactors,
  type ClassicWeek,
  type BookCandidate,
} from "../src/index.js";
import type { MarketLowZoneObservation } from "../src/market-low-zone.js";
const calendar = Array.from({ length: 150 }, (_, i) =>
  new Date(Date.UTC(2025, 0, 6 + i)).toISOString().slice(0, 10),
).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
const bars = (offset = 0) =>
  calendar.map((date, i) => {
    const close = 20 + offset + i * 0.05 + Math.sin(i / 3) * 0.4;
    return {
      date,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000,
      amount: 100000,
    };
  });
const base = {
  id: "book",
  version: 1,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["a", "b", "c", "d"] },
  entry: { kind: "constant", value: true },
  exit: { stop: { kind: "fixed", fraction: 0.08 } },
  sizing: { kind: "equal", positions: 2 },
  sleeve: "swing",
};
const candidates: BookCandidate[] = ["a", "b", "c", "d"].map((symbol, i) => ({
  symbol,
  bars: bars(i),
  decision: { entry: true, exit: false, stopLevel: 20 },
  external: {
    rps: calendar.map((date) => ({
      date,
      periods: [20, 50, 120],
      values: [20, 50, 120].map(() => ({
        return: 1,
        rank: 4 - i,
        rps: 20 + i * 20,
      })),
    })),
  },
}));
it("ranks actual RPS values, bounds future observations and refuses missing regime inputs", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    rank: { kind: "rps-composite" },
  });
  const date = calendar[79]!;
  const result = evaluateStrategyBook(strategy, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
  });
  expect(result.entries.map((e) => e.symbol)).toEqual(["d", "c"]);
  const changedFuture = candidates.map((c) => ({
    ...c,
    bars: c.bars.map((b) =>
      b.date > date ? { ...b, close: b.close * 100 } : b,
    ),
  }));
  expect(
    evaluateStrategyBook(strategy, {
      date,
      calendar,
      candidates: changedFuture,
      equity: 100000,
      initial: 100000,
      maxPositions: 2,
    }),
  ).toEqual(result);
  const gated = strategyObjectSchema.parse({
    ...strategy,
    regime: { kind: "trend-breadth", benchmark: "index" },
  });
  expect(
    evaluateStrategyBook(gated, {
      date,
      calendar,
      candidates,
      equity: 100000,
      initial: 100000,
      maxPositions: 2,
    }),
  ).toMatchObject({
    available: false,
    entries: [],
    reason: expect.stringContaining("Missing"),
  });
});
it("drawdown brake pauses exactly five decisions, resumes half and resets after recovery; transfers do not invent drawdown", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    rank: { kind: "rps-composite" },
    overlay: { volatilityTarget: 0.15 },
  });
  let previous = evaluateStrategyBook(strategy, {
    date: calendar[70]!,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
  });
  const scales: number[] = [];
  for (let i = 71; i <= 76; i++) {
    previous = evaluateStrategyBook(strategy, {
      date: calendar[i]!,
      calendar,
      candidates,
      equity: 84000,
      initial: 100000,
      maxPositions: 2,
      state: previous.state,
    });
    scales.push(previous.state.admissionScale!);
  }
  expect(scales).toEqual([0, 0, 0, 0, 0, 0.5]);
  previous = evaluateStrategyBook(strategy, {
    date: calendar[77]!,
    calendar,
    candidates,
    equity: 96000,
    initial: 100000,
    maxPositions: 2,
    state: previous.state,
  });
  expect(previous.state.admissionScale).toBe(1);
  const transferred = transferStrategyBook(previous.state, -46000);
  const after = evaluateStrategyBook(strategy, {
    date: calendar[78]!,
    calendar,
    candidates,
    equity: 50000,
    initial: 100000,
    maxPositions: 2,
    state: transferred,
  });
  expect(after.state.overlay?.nav).toBeCloseTo(previous.state.overlay!.nav, 12);
  expect(after.state.admissionScale).toBe(1);
});
it("classic one-step base targets exactly reuse the full schedule's buffer, inverse volatility and 15-percent cap", () => {
  const weeks: ClassicWeek[] = [calendar[79]!, calendar[84]!].map(
    (date, index) => ({
      date,
      nextDate: calendar[calendar.indexOf(date) + 1]!,
      marketBudget: 0.5,
      rows: candidates.map((c, i) => ({
        symbol: c.symbol,
        values: csi800ClassicFactors.map(
          (f) => (i + (index && i === 0 ? 10 : 0)) * f.direction,
        ),
        volatility: 0.1 + i * 0.01,
        amihud: i + 1,
        positiveEquity: true,
        reportDate: "2024-09-30",
        announcementDate: "2024-10-31",
        availableFrom: "2024-11-01",
        marketCap: 1000000,
      })),
    }),
  );
  const oracle = buildClassicSchedule(
    weeks,
    { model: "classic-five", count: 2, risk: "volatility" },
    (symbol, date) =>
      strategyBookReturns(
        candidates.find((c) => c.symbol === symbol)!.bars,
        date,
        calendar,
      ),
  );
  const strategy = strategyObjectSchema.parse({
    ...base,
    rank: { kind: "classic", model: "classic-five" },
    rebalance: { kind: "ranked-weekly", top: 2 },
    overlay: { volatilityTarget: 0.15 },
  });
  let state;
  for (let i = 0; i < weeks.length; i++) {
    const decision = evaluateStrategyBook(strategy, {
      date: weeks[i]!.date,
      calendar,
      candidates,
      equity: 100000,
      initial: 100000,
      maxPositions: 2,
      state,
      facts: { classicWeeks: weeks },
    });
    expect(decision.baseTargets).toEqual(oracle.allocations[i]!.weights);
    state = decision.state;
  }
  const excluded = oracle.audit[0]!.selected[0]!;
  const changedSignalBasis = candidates.map((candidate) => ({
    ...candidate,
    bars: candidate.bars.map((bar, i) => {
      const scale = i % 2 ? 0.5 : 2;
      return {
        ...bar,
        open: bar.open * scale,
        high: bar.high * scale,
        low: bar.low * scale,
        close: bar.close * scale,
      };
    }),
  }));
  const frozenRisk = candidates.map((candidate) => ({
    symbol: candidate.symbol,
    bars: candidate.bars,
  }));
  const stableBase = evaluateStrategyBook(strategy, {
    date: weeks[0]!.date,
    calendar,
    candidates: changedSignalBasis,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    facts: { classicWeeks: weeks, classicRiskSeries: frozenRisk },
  });
  expect(stableBase.baseTargets).toEqual(oracle.allocations[0]!.weights);
  const unfrozenRisk = evaluateStrategyBook(strategy, {
    date: weeks[0]!.date,
    calendar,
    candidates: changedSignalBasis,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    facts: { classicWeeks: weeks },
  });
  expect(unfrozenRisk.baseTargets).not.toEqual(stableBase.baseTargets);
  const masked = evaluateStrategyBook(strategy, {
    date: weeks[0]!.date,
    calendar,
    candidates: candidates.filter((c) => c.symbol !== excluded),
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    facts: {
      classicWeeks: weeks,
      classicRiskSeries: candidates.map((c) => ({
        symbol: c.symbol,
        bars: c.bars,
      })),
    },
  });
  expect(masked.baseTargets).toEqual(oracle.allocations[0]!.weights);
  expect(masked.targets).not.toHaveProperty(excluded);
  expect(masked.excludedBaseTargets).toContainEqual({
    symbol: excluded,
    weight: oracle.allocations[0]!.weights[excluded],
    reason:
      "outside-frozen-execution-universe; unallocated capital remains cash",
  });
  expect(
    Object.values(masked.targets!).reduce((n, w) => n + w, 0),
  ).toBeLessThan(Object.values(masked.baseTargets!).reduce((n, w) => n + w, 0));
});
it("chandelier protection ratchets only the next bar, and time exits require a real reset signal", () => {
  const exit = {
    chandelier: { period: 14, multiple: 3 },
    maxBars: 12,
    timeReentry: { cooldownBars: 1, requireNewSignal: true },
  };
  expect(
    nextStrategyProtection(exit, { stop: 9, high: 10 }, { high: 20 }, 15),
  ).toEqual({ stop: 15, high: 20 });
  expect(
    nextStrategyProtection(exit, { stop: 15, high: 20 }, { high: 19 }, 12),
  ).toEqual({ stop: 15, high: 20 });
  expect(
    strategyReentryAllowed(exit, { exitBar: 10, sawFalse: false }, 20, true),
  ).toBe(false);
  expect(
    strategyReentryAllowed(exit, { exitBar: 10, sawFalse: true }, 11, true),
  ).toBe(false);
  expect(
    strategyReentryAllowed(exit, { exitBar: 10, sawFalse: true }, 12, true),
  ).toBe(true);
});
it("uses 60 complete UTC daily returns for 4h END labels and rejects missing intraday bars", () => {
  const rows = Array.from({ length: 63 * 6 }, (_, i) => {
    const date = new Date(Date.UTC(2025, 0, 1, (i + 1) * 4)).toISOString();
    const close = 100 + Math.floor(i / 6) + (i % 6) / 10;
    return {
      date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
      amount: close,
    };
  });
  const axis = rows.map((b) => b.date),
    asOf = rows.at(-1)!.date;
  const result = strategyBookReturns(rows, asOf, axis, {
    market: "crypto",
    period: "4h",
  });
  expect(result).toHaveLength(60);
  expect(result![0]).toBeCloseTo(rows[23]!.close / rows[17]!.close - 1, 12);
  expect(
    strategyBookReturns(
      rows.filter((_, i) => i !== 80),
      asOf,
      axis,
      { market: "crypto", period: "4h" },
    ),
  ).toBeNull();
  const intraday = strategyBookReturns(rows, rows.at(-2)!.date, axis, {
    market: "crypto",
    period: "4h",
  });
  expect(intraday![0]).toBeCloseTo(rows[17]!.close / rows[11]!.close - 1, 12);
});
it("keeps held names without new entries in covariance, slots and existing stop-risk budgets", () => {
  const volatile = bars().map((b, i) => {
    const close = 100 * (1 + (i % 2 ? 0.2 : -0.2));
    return { ...b, open: close, close, high: close + 1, low: close - 1 };
  });
  const rows = [
    {
      ...candidates[0]!,
      bars: volatile,
      decision: { entry: false, exit: false, stopLevel: 60 },
    },
    candidates[3]!,
  ];
  const strategy = strategyObjectSchema.parse({
    ...base,
    overlay: { volatilityTarget: 0.15, heat: 0.06 },
  });
  const result = evaluateStrategyBook(strategy, {
    date: calendar[79]!,
    calendar,
    candidates: rows,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings: [{ symbol: "a", weight: 0.8, openRisk: 0.06 }],
  });
  expect(result.available).toBe(true);
  expect(result.estimatedVolatility).toBeGreaterThan(1);
  expect(result.targets?.a).toBeLessThan(0.8);
  expect(result.entries.find((e) => e.symbol === "d")).toBeUndefined();
  const full = evaluateStrategyBook(strategy, {
    date: calendar[79]!,
    calendar,
    candidates: rows,
    equity: 100000,
    initial: 100000,
    maxPositions: 1,
    holdings: [{ symbol: "a", weight: 0.8, openRisk: 0.06 }],
  });
  expect(full.entries).toEqual([]);
  expect(full.estimatedVolatility).toBeGreaterThan(1);
});
it("drawdown halves an existing holding once, repeats an unfilled target, and pause only blocks additions", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    overlay: { symbolWeight: 1 },
  });
  const rows = candidates.map((c) => ({
    ...c,
    decision: { ...c.decision, entry: false },
  }));
  const initial = evaluateStrategyBook(strategy, {
    date: calendar[70]!,
    calendar,
    candidates: rows,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings: [{ symbol: "a", weight: 0.5, openRisk: 0.01 }],
  });
  const reduced = evaluateStrategyBook(strategy, {
    date: calendar[71]!,
    calendar,
    candidates: rows,
    equity: 89000,
    initial: 100000,
    maxPositions: 2,
    holdings: [{ symbol: "a", weight: 0.5, openRisk: 0.01 }],
    state: initial.state,
  });
  expect(reduced.targets).toEqual({ a: 0.25 });
  const unfilled = evaluateStrategyBook(strategy, {
    date: calendar[72]!,
    calendar,
    candidates: rows,
    equity: 89000,
    initial: 100000,
    maxPositions: 2,
    holdings: [{ symbol: "a", weight: 0.5, openRisk: 0.01 }],
    state: reduced.state,
  });
  expect(unfilled.targets).toEqual({ a: 0.25 });
  let previous = unfilled;
  for (let i = 73; i < 79; i++) {
    previous = evaluateStrategyBook(strategy, {
      date: calendar[i]!,
      calendar,
      candidates: rows,
      equity: 84000,
      initial: 100000,
      maxPositions: 2,
      holdings: [{ symbol: "a", weight: 0.25, openRisk: 0.005 }],
      state: previous.state,
    });
    expect(previous.targets).toBeNull();
    expect(previous.entries).toEqual([]);
    expect(previous.existingExposureScale).toBe(0.5);
    expect(previous.entryAdmissionScale).toBe(i < 78 ? 0 : 0.5);
  }
  const recovered = evaluateStrategyBook(strategy, {
    date: calendar[79]!,
    calendar,
    candidates: rows,
    equity: 96000,
    initial: 100000,
    maxPositions: 2,
    holdings: [{ symbol: "a", weight: 0.25, openRisk: 0.005 }],
    state: previous.state,
  });
  expect(recovered.targets).toBeNull();
  expect(recovered.state.drawdownTargets).toBeUndefined();
});
it("signal regime is only an entry gate, while a known false weekly regime is an exposure switch", () => {
  const config = {
    kind: "trend-breadth",
    benchmark: "index",
    minimumBreadth: 0,
  };
  const signal = strategyObjectSchema.parse({ ...base, regime: config });
  const date = calendar[79]!,
    holdings = [{ symbol: "a", weight: 0.15, openRisk: 0.01 }];
  const falling = bars().map((b, i) => ({ ...b, close: 100 - i * 0.1 }));
  const gated = evaluateStrategyBook(signal, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings,
    facts: { benchmark: { symbol: "index", bars: falling } },
  });
  expect(gated).toMatchObject({
    available: true,
    regimeEffect: "entry-gate",
    entries: [],
    targets: null,
  });
  const unknown = evaluateStrategyBook(signal, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings,
  });
  expect(unknown).toMatchObject({
    available: false,
    entries: [],
    targets: null,
  });
  const weekly = strategyObjectSchema.parse({
    ...signal,
    rank: { kind: "rps-composite" },
    rebalance: { kind: "ranked-weekly", top: 1, weighting: "equal" },
  });
  const switched = evaluateStrategyBook(weekly, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings,
    facts: { benchmark: { symbol: "index", bars: falling } },
  });
  expect(switched.regimeEffect).toBe("exposure-switch");
  expect(Object.values(switched.targets!)).toEqual([0]);
  expect(switched.adjustments?.find((a) => a.symbol === "a")).toMatchObject({
    side: "sell",
    targetWeight: 0,
  });
  const missingRank = evaluateStrategyBook(
    strategyObjectSchema.parse({ ...weekly, regime: undefined }),
    {
      date,
      calendar,
      candidates: candidates.map((c) => ({ ...c, external: { rps: [] } })),
      equity: 100000,
      initial: 100000,
      maxPositions: 2,
      holdings,
    },
  );
  expect(missingRank).toMatchObject({
    available: false,
    targets: null,
    entries: [],
    reason: expect.stringContaining("RPS"),
  });
  const missingPrice = evaluateStrategyBook(
    strategyObjectSchema.parse({ ...weekly, regime: undefined }),
    {
      date,
      calendar,
      candidates: candidates.map((c) => ({
        ...c,
        bars: c.bars.filter((b) => b.date !== date),
        decision: { entry: null, exit: null, stopLevel: null },
      })),
      equity: 100000,
      initial: 100000,
      maxPositions: 2,
      holdings,
    },
  );
  expect(missingPrice).toMatchObject({
    available: false,
    targets: null,
    entries: [],
    reason: expect.stringContaining("completed-bar"),
  });
});
it("a paused weekly replacement permits known exits but cannot buy a newly top-ranked name", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    rank: { kind: "rps-composite" },
    rebalance: { kind: "ranked-weekly", top: 1, weighting: "equal" },
    overlay: { symbolWeight: 1 },
  });
  const previous = evaluateStrategyBook(strategy, {
    date: calendar[74]!,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 1,
    holdings: [],
  });
  const held = [{ symbol: "a", weight: 0.15, openRisk: 0.01 }];
  const paused = evaluateStrategyBook(strategy, {
    date: calendar[79]!,
    calendar,
    candidates,
    equity: 84000,
    initial: 100000,
    maxPositions: 1,
    holdings: held,
    state: { ...previous.state, selected: ["a"] },
  });
  expect(paused.entryAdmissionScale).toBe(0);
  expect(Object.values(paused.targets!)).toEqual([0]);
  expect(paused.adjustments?.find((a) => a.symbol === "a")).toMatchObject({
    side: "sell",
    targetWeight: 0,
  });
  expect(paused.adjustments?.every((a) => a.side === "sell")).toBe(true);
  expect(paused.state.selected).toEqual(["d"]);
  expect(paused.exposure).toBe(0);
});
it("other-strategy holdings remain risk inputs without creating entries outside this strategy's universe", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    universe: { kind: "symbols", symbols: ["a"] },
    overlay: { symbolWeight: 0.15 },
  });
  const result = evaluateStrategyBook(strategy, {
    date: calendar[79]!,
    calendar,
    candidates: [
      { ...candidates[0]!, eligible: true },
      { ...candidates[1]!, eligible: false },
    ],
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings: [
      { symbol: "a", weight: 0.05, openRisk: 0.005 },
      { symbol: "b", weight: 0.1, openRisk: 0.01, managed: false },
    ],
  });
  expect(result.entries.map((e) => e.symbol)).toEqual(["a"]);
  expect(result.targets).toBeNull();
});
it("market low-zone targetShare caps only new aggregate exposure and a zero/non-entry state does not liquidate holdings", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    sleeve: "low-zone",
    entry: { kind: "external", id: "l3-market-low-zone", side: "entry" },
    overlay: { symbolWeight: 1 },
  });
  const date = calendar[79]!,
    fact = {
      date,
      role: "primary",
      index: "sh000300",
      entry: true,
      exit: false,
      targetShare: 0.3,
    } as MarketLowZoneObservation;
  const holdings = [{ symbol: "a", weight: 0.25, openRisk: 0.01 }];
  const active = evaluateStrategyBook(strategy, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings,
    facts: { marketLowZone: [fact] },
  });
  expect(active.marketTargetShare).toBe(0.3);
  expect(active.entries.reduce((n, e) => n + e.deltaWeight!, 0)).toBeCloseTo(
    0.05,
    12,
  );
  const notEntry = evaluateStrategyBook(strategy, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings,
    facts: { marketLowZone: [{ ...fact, entry: false, targetShare: 0 }] },
  });
  expect(notEntry).toMatchObject({
    available: true,
    entries: [],
    targets: null,
  });
  const unknown = evaluateStrategyBook(strategy, {
    date,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
    holdings,
    facts: { marketLowZone: [{ ...fact, entry: null, targetShare: null }] },
  });
  expect(unknown).toMatchObject({
    available: false,
    entries: [],
    targets: null,
  });
});
it("equal sizing has no implicit volatility target while drawdown protection still applies", () => {
  const strategy = strategyObjectSchema.parse({
    ...base,
    overlay: { symbolWeight: 1 },
  });
  const first = evaluateStrategyBook(strategy, {
    date: calendar[79]!,
    calendar,
    candidates,
    equity: 100000,
    initial: 100000,
    maxPositions: 2,
  });
  expect(first.estimatedVolatility).toBeNull();
  expect(first.entries.map((e) => e.weight)).toEqual([0.5, 0.5]);
  const reduced = evaluateStrategyBook(strategy, {
    date: calendar[80]!,
    calendar,
    candidates,
    equity: 89000,
    initial: 100000,
    maxPositions: 2,
    state: first.state,
  });
  expect(reduced.entries.map((e) => e.weight)).toEqual([0.25, 0.25]);
});
