import type { Bar } from "trading-strategy-core/bars";
import { calculateFactor } from "trading-strategy-core/factors";
import type {
  StrategyObject,
  StrategyObjectInput,
  StrategyDecision,
  StrategyExternalInputs,
} from "./strategy-object.js";
import {
  buildClassicSchedule,
  classicPortfolioVolatility,
  scoreClassicWeek,
  classicModelScore,
  type ClassicWeek,
} from "./csi800-composite.js";
import { csi800Weights } from "./csi800-model.js";
import { researchCorrelationGroups } from "./research/risk/research-group-risk.js";
import type { MarketLowZoneObservation } from "./market-low-zone.js";
import {
  evaluateOneilMarketDirection,
  evaluateDowDualIndex,
  type OneilMarketDirection,
  type DowDualIndexDirection,
} from "./theory-regime-gates.js";

export type BookCandidate = {
  symbol: string;
  bars: readonly Bar[];
  decision: StrategyDecision;
  external?: StrategyExternalInputs;
  eligible?: boolean;
};
export type StrategyBookFacts = {
  benchmark?: { symbol: string; bars: readonly Bar[] };
  /** A bare series belongs to the configured secondaryBenchmark. */
  secondaryBenchmarkBars?:
    readonly Bar[] | { symbol: string; bars: readonly Bar[] };
  classicWeeks?: readonly ClassicWeek[];
  classicRiskSeries?: readonly {
    symbol: string;
    bars: readonly Pick<Bar, "date" | "close">[];
  }[];
  industries?: readonly {
    symbol: string;
    date: string;
    availableAt: string;
    industry?: string;
    groups?: readonly string[];
    source: string;
    basis: "point-in-time" | "current";
  }[];
  marketLowZone?: readonly MarketLowZoneObservation[];
  roundTripCost?: number;
};
export type StrategyBookState = {
  selected: string[];
  baseTargets?: Record<string, number>;
  admissionScale?: number;
  riskGroups?: string[][];
  industries?: Record<string, string[]>;
  riskAsOf?: string;
  drawdownTargets?: Record<string, number>;
  overlay?: {
    nav: number;
    peak: number;
    previousEquity: number;
    index: number;
    pausedThrough: number;
    reduced: boolean;
    pauseArmed: boolean;
    date: string;
  };
};
export type BookAdmission = {
  symbol: string;
  score: number;
  weight: number;
  currentWeight?: number;
  deltaWeight?: number;
  rps?: {
    period: number;
    actual: { return: number; rank: number; rps: number } | null;
  }[];
};
export type BookAdjustment = {
  symbol: string;
  side: "buy" | "sell";
  currentWeight: number;
  targetWeight: number;
  deltaWeight: number;
};
export type StrategyBookDecision = {
  date: string;
  available: boolean;
  reason: string | null;
  entries: BookAdmission[];
  targets: Record<string, number> | null;
  exposure: number;
  state: StrategyBookState;
  regime:
    | ({
        trend: boolean | null;
        breadth: number | null;
        coverage: number | null;
      } & (
        | { kind?: undefined }
        | ({ kind: "oneil-market-direction" } & OneilMarketDirection)
        | ({ kind: "dow-dual-index" } & DowDualIndexDirection)
      ))
    | null;
  estimatedVolatility: number | null;
  baseTargets?: Record<string, number>;
  excludedBaseTargets?: { symbol: string; weight: number; reason: string }[];
  biasTags?: string[];
  riskGroups?: string[][];
  industries?: Record<string, string[]>;
  riskAsOf?: string;
  adjustments?: BookAdjustment[];
  regimeEffect?: "entry-gate" | "exposure-switch";
  entryAdmissionScale?: number;
  existingExposureScale?: number;
  marketTargetShare?: number;
  marketLowZone?: MarketLowZoneObservation;
};

export const usesStrategyBook = (s: StrategyObjectInput) =>
  !!(s.rank || s.regime || s.overlay || s.rebalance || s.costFilter);

/** Binary search bounds future data without repeatedly copying the whole history. */
function indexAt(bars: readonly Pick<Bar, "date">[], date: string) {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (bars[mid]!.date <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
export function strategyBookReturns(
  bars: readonly Pick<Bar, "date" | "close">[],
  date: string,
  calendar: readonly string[],
  options?: { market: "cn-equity" | "crypto"; period: string },
) {
  if (options?.market === "crypto") {
    // Intraday labels are END boundaries; daily labels identify the opening day.
    const intraday = options.period === "4h";
    const duration = intraday ? 4 * 3600000 : 86400000;
    const completedThrough = Date.parse(date) + (intraday ? 0 : duration);
    const finalDay = Math.floor(completedThrough / 86400000) - 1;
    const closes = new Map(
      bars
        .filter((b) => b.date <= date)
        .map((b) => [Date.parse(b.date), b.close]),
    );
    const expected = new Set(
      calendar.filter((d) => d <= date).map((d) => Date.parse(d)),
    );
    const daily: number[] = [];
    for (let day = finalDay - 60; day <= finalDay; day++) {
      let close = 0;
      for (
        let time = day * 86400000 + (intraday ? duration : 0);
        time < (day + 1) * 86400000 + (intraday ? duration : 0);
        time += duration
      ) {
        const value = closes.get(time);
        if (
          !expected.has(time) ||
          value === undefined ||
          !Number.isFinite(value) ||
          value <= 0
        )
          return null;
        close = value;
      }
      daily.push(close);
    }
    return daily.slice(1).map((close, i) => close / daily[i]! - 1);
  }
  const days = calendar.filter((d) => d <= date).slice(-61),
    end = indexAt(bars, date);
  const window = bars.slice(Math.max(0, end - 60), end + 1);
  if (
    days.length !== 61 ||
    window.length !== 61 ||
    window.some(
      (b, i) => b.date !== days[i] || !Number.isFinite(b.close) || b.close <= 0,
    )
  )
    return null;
  return window.slice(1).map((b, i) => b.close / window[i]!.close - 1);
}
function regimeAt(
  strategy: StrategyObject,
  candidates: readonly BookCandidate[],
  date: string,
  facts: StrategyBookFacts,
) {
  const config = strategy.regime!;
  // The preregistered crypto benchmark gate is DAILY even for 4h entries.
  const benchmarkDate =
    strategy.market === "crypto" && strategy.period === "4h"
      ? new Date((Math.floor(Date.parse(date) / 86400000) - 1) * 86400000)
          .toISOString()
          .slice(0, 10)
      : date;
  const bars =
    facts.benchmark?.symbol === config.benchmark ? facts.benchmark.bars : [];
  if (
    config.kind === "oneil-market-direction" ||
    config.kind === "dow-dual-index"
  ) {
    const basis = { trend: null, breadth: null, coverage: null };
    if (config.kind === "oneil-market-direction")
      return {
        ...basis,
        kind: config.kind,
        ...evaluateOneilMarketDirection(bars, {
          ...config,
          asOf: benchmarkDate,
        }),
      };
    const secondary = facts.secondaryBenchmarkBars;
    const secondaryBars =
      secondary && "bars" in secondary
        ? secondary.symbol === config.secondaryBenchmark
          ? secondary.bars
          : []
        : (secondary ?? []);
    return {
      ...basis,
      kind: config.kind,
      ...evaluateDowDualIndex(bars, secondaryBars, {
        ...config,
        asOf: benchmarkDate,
      }),
    };
  }
  const i = indexAt(bars, benchmarkDate),
    window = bars.slice(Math.max(0, i - config.period), i + 1);
  const valid =
    window.length === config.period + 1 &&
    window.at(-1)?.date === benchmarkDate &&
    window.every((b) => Number.isFinite(b.close) && b.close > 0);
  const mean = (xs: readonly Bar[]) =>
    xs.reduce((n, b) => n + b.close / xs.length, 0);
  const trend = valid
    ? window.at(-1)!.close > mean(window.slice(1)) &&
      mean(window.slice(1)) > mean(window.slice(0, -1))
    : null;
  if (config.minimumBreadth === 0) return { trend, breadth: 1, coverage: 1 };
  const available = candidates.flatMap((c) => {
    const j = indexAt(c.bars, date),
      rows = c.bars.slice(Math.max(0, j - config.period + 1), j + 1);
    return rows.length === config.period &&
      rows.at(-1)?.date === date &&
      rows.every((b) => b.close > 0 && Number.isFinite(b.close))
      ? [rows.at(-1)!.close > mean(rows)]
      : [];
  });
  const coverage = candidates.length ? available.length / candidates.length : 0;
  return {
    trend,
    breadth:
      coverage >= config.minimumCoverage && available.length
        ? available.filter(Boolean).length / available.length
        : null,
    coverage,
  };
}
function overlayAt(
  strategy: StrategyObject,
  equity: number,
  initial: number,
  date: string,
  previous?: StrategyBookState["overlay"],
) {
  const rule = strategy.overlay!.drawdownBrake;
  if (
    !(equity > 0) ||
    !(initial > 0) ||
    (previous && !(previous.previousEquity > 0))
  )
    throw new Error("Invalid overlay equity");
  if (previous?.date === date) throw new Error("Duplicate book overlay date");
  const nav = previous
    ? (previous.nav * equity) / previous.previousEquity
    : equity / initial;
  const peak = Math.max(previous?.peak ?? 1, nav),
    drawdown = 1 - nav / peak;
  const state = {
    nav,
    peak,
    previousEquity: equity,
    index: (previous?.index ?? -1) + 1,
    pausedThrough: previous?.pausedThrough ?? -1,
    reduced: previous?.reduced ?? false,
    pauseArmed: previous?.pauseArmed ?? true,
    date,
  };
  if (drawdown <= rule.recoverAt) {
    state.reduced = false;
    state.pauseArmed = true;
    state.pausedThrough = -1;
  } else if (drawdown >= rule.pauseAt && state.pauseArmed) {
    state.reduced = true;
    state.pauseArmed = false;
    state.pausedThrough = state.index + rule.pauseBars - 1;
  } else if (drawdown >= rule.reduceAt) state.reduced = true;
  return {
    state,
    entryScale:
      state.index <= state.pausedThrough ? 0 : state.reduced ? 0.5 : 1,
    existingScale: state.reduced ? 0.5 : 1,
  };
}
/** A capital transfer changes the starting capital for the next return, not NAV. */
export function transferStrategyBook(
  state: StrategyBookState,
  amount: number,
): StrategyBookState {
  return state.overlay
    ? {
        ...state,
        overlay: {
          ...state.overlay,
          previousEquity: state.overlay.previousEquity + amount,
        },
      }
    : state;
}
const isoWeek = (date: string) => {
  const d = new Date(date.slice(0, 10));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/** One completed-universe decision shared by scan, watch, paper and backtest. */
export function evaluateStrategyBook(
  strategy: StrategyObject,
  input: {
    date: string;
    calendar: readonly string[];
    candidates: readonly BookCandidate[];
    equity: number;
    initial: number;
    maxPositions: number;
    state?: StrategyBookState;
    facts?: StrategyBookFacts;
    holdings?: readonly {
      symbol: string;
      weight: number;
      openRisk: number | null;
      managed?: boolean;
    }[];
  },
): StrategyBookDecision {
  const { date, candidates } = input,
    facts = input.facts ?? {};
  const lowMarket = facts.marketLowZone?.find(
    (f) => f.date === date && f.role === "primary",
  );
  let marketTargetShare: number | undefined;
  const universe = candidates.filter((c) => c.eligible !== false),
    holdings = input.holdings ?? [];
  const ownWeight = (symbol: string) =>
    holdings
      .filter((h) => h.symbol === symbol && h.managed !== false)
      .reduce((n, h) => n + h.weight, 0);
  const otherWeight = (symbol: string) =>
    holdings
      .filter((h) => h.symbol === symbol && h.managed === false)
      .reduce((n, h) => n + h.weight, 0);
  const adjustmentsFor = (
    targets: Record<string, number> | null,
  ): BookAdjustment[] =>
    targets === null
      ? []
      : [
          ...new Set([
            ...Object.keys(targets),
            ...holdings.filter((h) => h.managed !== false).map((h) => h.symbol),
          ]),
        ].flatMap((symbol) => {
          const currentWeight = ownWeight(symbol),
            targetWeight = targets[symbol] ?? 0,
            deltaWeight = targetWeight - currentWeight;
          return Math.abs(deltaWeight) <= 1e-10
            ? []
            : [
                {
                  symbol,
                  side: deltaWeight > 0 ? ("buy" as const) : ("sell" as const),
                  currentWeight,
                  targetWeight,
                  deltaWeight,
                },
              ];
        });
  const state: StrategyBookState = {
    ...input.state,
    selected: [...(input.state?.selected ?? [])],
    ...(input.state?.overlay ? { overlay: { ...input.state.overlay } } : {}),
  };
  let exposure = 1,
    existingScale = 1,
    regimeMissing: string | null = null,
    regime: StrategyBookDecision["regime"] = null,
    estimatedVolatility: number | null = null;
  const knownReduction = () =>
    state.drawdownTargets
      ? Object.fromEntries(
          holdings
            .filter(
              (h) =>
                h.managed !== false &&
                state.drawdownTargets![h.symbol] !== undefined &&
                ownWeight(h.symbol) > state.drawdownTargets![h.symbol]!,
            )
            .map((h) => [h.symbol, state.drawdownTargets![h.symbol]!]),
        )
      : {};
  const unavailable = (reason: string): StrategyBookDecision => {
    const reductions = knownReduction();
    const targets = Object.keys(reductions).length
      ? {
          ...Object.fromEntries(
            holdings
              .filter((h) => h.managed !== false)
              .map((h) => [h.symbol, ownWeight(h.symbol)]),
          ),
          ...reductions,
        }
      : null;
    return {
      date,
      available: false,
      reason,
      entries: [],
      targets,
      exposure: holdings.reduce((n, h) => n + h.weight, 0),
      state,
      regime,
      estimatedVolatility,
      adjustments: adjustmentsFor(targets),
      regimeEffect: strategy.rebalance ? "exposure-switch" : "entry-gate",
      entryAdmissionScale: 0,
      existingExposureScale: existingScale,
    };
  };
  if (!Number.isFinite(input.equity) || !Number.isFinite(input.initial))
    throw new Error("Invalid book equity");
  if (input.equity <= 0 || input.initial <= 0)
    return unavailable("Unfunded book");
  if (strategy.overlay) {
    const next = overlayAt(
      strategy,
      input.equity,
      input.initial,
      date,
      state.overlay,
    );
    state.overlay = next.state;
    exposure *= next.entryScale;
    existingScale = next.existingScale;
    if (!next.state.reduced) state.drawdownTargets = undefined;
    else if (!input.state?.overlay?.reduced)
      state.drawdownTargets = Object.fromEntries(
        holdings
          .filter((h) => h.managed !== false)
          .map((h) => [h.symbol, ownWeight(h.symbol) * 0.5]),
      );
  }
  if (strategy.regime) {
    regime = regimeAt(strategy, universe, date, facts);
    const scale = regime.kind
      ? regime.scale
      : regime.trend === null || regime.breadth === null
        ? null
        : strategy.regime.kind === "trend-breadth" &&
            regime.trend &&
            regime.breadth >= strategy.regime.minimumBreadth
          ? 1
          : 0;
    if (scale === null) {
      regimeMissing = regime.kind
        ? `Missing causal ${regime.kind} benchmark observations`
        : "Missing causal benchmark / breadth";
      if (strategy.rebalance) return unavailable(regimeMissing);
      exposure = 0;
    } else {
      exposure *= scale;
      if (strategy.rebalance) existingScale *= scale;
    }
  }
  if (
    strategy.entry.kind === "external" &&
    strategy.entry.id === "l3-market-low-zone"
  ) {
    if (
      !lowMarket ||
      lowMarket.entry === null ||
      lowMarket.exit === null ||
      lowMarket.targetShare === null
    )
      return unavailable("Missing market-level low-zone evidence");
    if (!lowMarket.entry) exposure = 0;
    else marketTargetShare = lowMarket.targetShare;
  }
  if (
    strategy.costFilter &&
    (facts.roundTripCost === undefined ||
      !Number.isFinite(facts.roundTripCost) ||
      facts.roundTripCost < 0)
  )
    return unavailable("Missing frozen round-trip costs");
  const admissionScale = exposure;
  exposure = 1;
  const rebalance = strategy.rebalance;
  const nextCalendar = input.calendar.find((d) => d > date);
  const weeklySignal =
    !!nextCalendar && isoWeek(date) !== isoWeek(nextCalendar);
  const riskAt = (symbol: string) => {
    const bars =
      strategy.rank?.kind === "classic" && facts.classicRiskSeries !== undefined
        ? facts.classicRiskSeries.find((r) => r.symbol === symbol)?.bars
        : candidates.find((r) => r.symbol === symbol)?.bars;
    return bars
      ? strategyBookReturns(bars, date, input.calendar, strategy)
      : null;
  };
  if (rebalance && holdings.some((h) => h.managed === false && h.weight > 0))
    return unavailable(
      "Ranked target book requires a dedicated sleeve; other strategies retain their holdings",
    );
  if (rebalance && admissionScale === 0 && existingScale > 0 && !weeklySignal) {
    // A pause preserves the held half-book; it cannot rotate into new names
    // through target orders while the entry admission list is empty.
    const held = [
      ...new Set(
        holdings.filter((h) => h.managed !== false).map((h) => h.symbol),
      ),
    ];
    const weights = held.map((symbol) =>
      state.baseTargets && !state.selected.includes(symbol)
        ? 0
        : Math.min(
            ownWeight(symbol),
            state.drawdownTargets?.[symbol] ?? ownWeight(symbol),
          ),
    );
    let scale = 1;
    if (strategy.overlay?.volatilityTarget !== undefined && held.length) {
      const vectors = held.map(riskAt);
      if (vectors.some((v) => v === null))
        return unavailable(
          "Missing held-book covariance during admission pause",
        );
      estimatedVolatility = classicPortfolioVolatility(
        vectors as number[][],
        weights,
      );
      if (estimatedVolatility === null)
        return unavailable(
          "Missing held-book volatility during admission pause",
        );
      estimatedVolatility *= Math.sqrt(
        strategy.market === "crypto" ? 365 / 252 : 1,
      );
      scale =
        estimatedVolatility === 0
          ? 1
          : Math.min(
              1,
              strategy.overlay.volatilityTarget / estimatedVolatility,
            );
    }
    const reductions = Object.fromEntries(
      held.map((symbol, i) => [symbol, weights[i]! * scale]),
    );
    const targets = held.some(
      (symbol) => reductions[symbol]! < ownWeight(symbol) - 1e-10,
    )
      ? reductions
      : null;
    state.admissionScale = existingScale;
    return {
      date,
      available: true,
      reason:
        "DD admission pause: no positive deltas; preserve known weekly exits and the held risk ceiling",
      entries: [],
      targets,
      exposure: weights.reduce((n, w) => n + w * scale, 0),
      state,
      regime,
      estimatedVolatility,
      adjustments: adjustmentsFor(targets),
      regimeEffect: "exposure-switch",
      entryAdmissionScale: 0,
      existingExposureScale: existingScale,
      industries: state.industries,
      riskGroups: state.riskGroups,
      riskAsOf: state.riskAsOf,
    };
  }
  if (rebalance) {
    if (!weeklySignal) {
      const targets =
        state.baseTargets && input.state?.admissionScale !== existingScale
          ? Object.fromEntries(
              Object.entries(state.baseTargets).map(([s, w]) => [
                s,
                w * existingScale,
              ]),
            )
          : null;
      state.admissionScale = existingScale;
      return {
        date,
        available: true,
        reason: null,
        entries: [],
        targets,
        exposure: targets
          ? Object.values(targets).reduce((n, w) => n + w, 0)
          : exposure,
        state,
        regime,
        estimatedVolatility,
        riskGroups: state.riskGroups,
        industries: state.industries,
        riskAsOf: state.riskAsOf,
        adjustments: adjustmentsFor(targets),
        regimeEffect: "exposure-switch",
        entryAdmissionScale: admissionScale,
        existingExposureScale: existingScale,
      };
    }
  }
  state.admissionScale = strategy.rebalance ? existingScale : admissionScale;
  const week = facts.classicWeeks?.find((w) => w.date === date);
  let classicScores: Map<string, number> | undefined;
  if (strategy.rank?.kind === "classic") {
    if (!week) return unavailable("Missing frozen classic factor panel");
    if (
      week.rows.some(
        (r) =>
          (r.reportDate !== null && r.reportDate > date) ||
          (r.availableFrom !== null && r.availableFrom > date) ||
          (r.announcementDate !== null && r.announcementDate >= date),
      )
    )
      throw new Error("Non-causal classic financial panel");
    classicScores = new Map(
      scoreClassicWeek(week).flatMap((r) => {
        const score = classicModelScore(r, "classic-five");
        return score === null ? [] : [[r.symbol, score] as const];
      }),
    );
  }
  let missingRank = false,
    missingPrice = false;
  const ranked = universe
    .flatMap((c) => {
      const i = indexAt(c.bars, date);
      if (i < 0 || c.bars[i]!.date !== date) {
        missingPrice = true;
        return [];
      }
      let score = 0;
      if (strategy.rank?.kind === "rps-composite") {
        const point = c.external?.rps?.find((p) => p.date === date);
        const values = strategy.rank.periods.map(
          (p) => point?.values[point.periods.indexOf(p)]?.rps,
        );
        if (values.some((v) => v == null || !Number.isFinite(v))) {
          missingRank = true;
          return [];
        }
        score = values.reduce<number>(
          (n, v) => n + v! / values.length / 100,
          0,
        );
      } else if (classicScores) {
        const value = classicScores.get(c.symbol);
        if (value === undefined) return [];
        score = value;
      }
      if (strategy.costFilter) {
        const cost = facts.roundTripCost;
        if (cost === undefined || !Number.isFinite(cost) || cost < 0) return [];
        const prefix = c.bars.slice(
          Math.max(0, i - strategy.costFilter.atrPeriod * 2),
          i + 1,
        );
        const range = calculateFactor(prefix, {
          id: "atr",
          parameters: { period: strategy.costFilter.atrPeriod },
        }).values.at(-1);
        if (
          range == null ||
          range / c.bars[i]!.close <=
            strategy.costFilter.minimumMoveToCost * cost
        )
          return [];
      }
      return [{ ...c, score }];
    })
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  if (missingPrice) return unavailable("Missing required completed-bar inputs");
  if (missingRank)
    return unavailable("Missing registered cross-sectional RPS inputs");
  const heldSymbols = new Set(
    holdings.filter((h) => h.weight > 0).map((h) => h.symbol),
  );
  const heldRows = [...heldSymbols].flatMap((symbol) => {
    const row =
      ranked.find((r) => r.symbol === symbol) ??
      candidates.find((r) => r.symbol === symbol);
    return row
      ? [
          {
            ...row,
            decision:
              row.eligible === false
                ? { ...row.decision, entry: false }
                : row.decision,
            score: "score" in row ? (row.score as number) : 0,
          },
        ]
      : [];
  });
  if (!rebalance && heldRows.length !== heldSymbols.size)
    return unavailable("Missing existing holding covariance series");
  let selected = rebalance
    ? ranked
        .filter(
          (r, i) =>
            i < Math.ceil(rebalance.top * rebalance.retentionMultiple) &&
            state.selected.includes(r.symbol),
        )
        .slice(0, rebalance.top)
    : [
        ...heldRows,
        ...ranked
          .filter(
            (r) =>
              admissionScale > 0 &&
              !heldSymbols.has(r.symbol) &&
              r.decision.entry === true &&
              r.decision.exit !== true,
          )
          .slice(0, Math.max(0, input.maxPositions - heldSymbols.size)),
      ];
  if (rebalance)
    for (const row of ranked)
      if (
        selected.length < rebalance.top &&
        !selected.some((s) => s.symbol === row.symbol)
      )
        selected.push(row);
  let weights: Record<string, number>,
    baseTargets: Record<string, number> | undefined;
  let excludedBaseTargets: StrategyBookDecision["excludedBaseTargets"];
  if (strategy.rank?.kind === "classic" && rebalance) {
    const schedule = buildClassicSchedule(
      [week!],
      {
        model: "classic-five",
        count: rebalance.top,
        retentionMultiple: rebalance.retentionMultiple,
        risk:
          strategy.overlay?.volatilityTarget !== undefined
            ? "volatility"
            : "none",
        previousSelection: state.selected,
        ...(strategy.overlay?.volatilityTarget !== undefined
          ? { volatilityTarget: strategy.overlay.volatilityTarget }
          : {}),
      },
      (symbol) => riskAt(symbol),
    );
    const audit = schedule.audit[0]!;
    if (audit.riskMissing)
      return unavailable("Missing 60-bar classic portfolio covariance inputs");
    state.selected = audit.selected;
    estimatedVolatility = audit.estimatedVolatility;
    baseTargets = schedule.allocations[0]!.weights;
    const executable = new Set(universe.map((c) => c.symbol));
    excludedBaseTargets = Object.entries(baseTargets)
      .filter(([symbol]) => !executable.has(symbol))
      .map(([symbol, weight]) => ({
        symbol,
        weight,
        reason:
          "outside-frozen-execution-universe; unallocated capital remains cash",
      }));
    weights = Object.fromEntries(
      Object.entries(baseTargets).filter(([symbol]) => executable.has(symbol)),
    );
    selected = ranked.filter((r) => state.selected.includes(r.symbol));
  } else {
    const vectors = selected.map((c) => riskAt(c.symbol));
    const inverse = selected.map((_, i) => {
      const r = vectors[i];
      const vol = r ? classicPortfolioVolatility([r], [1]) : null;
      return vol !== null && vol > 0 ? 1 / vol : null;
    });
    const base = rebalance
      ? rebalance.weighting === "inverse-volatility"
        ? inverse
        : selected.map(() => 1)
      : selected.map((c) => {
          const held =
            otherWeight(c.symbol) +
            Math.min(
              ownWeight(c.symbol),
              state.drawdownTargets?.[c.symbol] ?? ownWeight(c.symbol),
            );
          return admissionScale > 0 &&
            c.decision.entry === true &&
            c.decision.exit !== true
            ? Math.max(held, admissionScale / input.maxPositions)
            : held;
        });
    if (
      (strategy.overlay?.volatilityTarget !== undefined ||
        rebalance?.weighting === "inverse-volatility") &&
      selected.length &&
      (base.some((w) => w === null) || vectors.some((v) => v === null))
    )
      return unavailable("Missing 60-day portfolio covariance inputs");
    const normalized = base.map(
      (w) => w! / base.reduce<number>((n, v) => n + v!, 0),
    );
    if (strategy.overlay?.volatilityTarget !== undefined && selected.length) {
      estimatedVolatility = classicPortfolioVolatility(
        vectors as number[][],
        rebalance ? normalized : (base as number[]),
      );
      if (estimatedVolatility === null)
        return unavailable("Missing portfolio volatility");
      estimatedVolatility *= Math.sqrt(
        strategy.market === "crypto" ? 365 / 252 : 1,
      );
      exposure *=
        estimatedVolatility === 0
          ? 1
          : Math.min(
              1,
              strategy.overlay.volatilityTarget / estimatedVolatility,
            );
    }
    const count = rebalance?.top ?? input.maxPositions;
    if (rebalance) exposure *= Math.min(1, selected.length / count);
    const allocated = rebalance
      ? csi800Weights(
          base.map((w) => w!),
          exposure,
        )
      : base.map((w) => w! * exposure);
    weights = Object.fromEntries(
      selected.map((c, i) => [c.symbol, allocated[i]!]),
    );
    if (rebalance) state.selected = selected.map((c) => c.symbol);
  }
  const biasTags: string[] = [];
  let riskGroups: string[][] | undefined,
    industries: Record<string, string[]> | undefined;
  const heldWeight = (symbol: string) =>
    holdings
      .filter((h) => h.symbol === symbol)
      .reduce((n, h) => n + h.weight, 0);
  const addedWeight = (symbol: string) =>
    rebalance
      ? (weights[symbol] ?? 0)
      : Math.max(0, (weights[symbol] ?? 0) - heldWeight(symbol));
  const limitAdditions = (symbols: readonly string[], scale: number) => {
    for (const symbol of symbols)
      if (weights[symbol] !== undefined)
        weights[symbol] = rebalance
          ? weights[symbol]! * scale
          : Math.min(
              weights[symbol]!,
              heldWeight(symbol) + addedWeight(symbol) * scale,
            );
  };
  if (strategy.overlay?.symbolWeight !== undefined)
    for (const symbol of Object.keys(weights))
      weights[symbol] = Math.min(
        weights[symbol]!,
        strategy.overlay.symbolWeight,
      );
  if (marketTargetShare !== undefined) {
    const room = Math.max(
        0,
        marketTargetShare - holdings.reduce((n, h) => n + h.weight, 0),
      ),
      additions = Object.keys(weights).reduce((n, s) => n + addedWeight(s), 0);
    if (additions > room)
      limitAdditions(Object.keys(weights), room / additions);
  }
  const risks = new Map<string, number>();
  if (
    strategy.overlay?.heat !== undefined ||
    strategy.overlay?.correlationGroupRisk !== undefined
  ) {
    for (const row of selected.filter(
      (row) => rebalance || (weights[row.symbol] ?? 0) > heldWeight(row.symbol),
    )) {
      const close = row.bars[indexAt(row.bars, date)]!.close,
        stop = row.decision.stopLevel;
      if (stop === null || !(stop > 0 && stop < close))
        return unavailable("Missing planned stop-risk basis");
      risks.set(row.symbol, (close - stop) / close);
    }
    if (!rebalance && holdings.some((h) => h.openRisk === null))
      return unavailable("Existing holding stop risk is unknown");
    const priorRisk = rebalance
      ? 0
      : holdings.reduce((n, h) => n + h.openRisk!, 0);
    const heat = Object.keys(weights).reduce(
      (n, s) => n + addedWeight(s) * (risks.get(s) ?? 0),
      0,
    );
    const room = Math.max(0, (strategy.overlay.heat ?? 1) - priorRisk);
    if (strategy.overlay.heat !== undefined && heat > room)
      limitAdditions(Object.keys(weights), room / heat);
  }
  if (
    strategy.overlay?.industryWeight !== undefined ||
    strategy.overlay?.correlationGroupRisk !== undefined
  ) {
    const sectors = new Map<string, readonly string[]>();
    const groupSymbols = [
      ...new Set([
        ...selected.map((r) => r.symbol),
        ...(!rebalance ? holdings.map((h) => h.symbol) : []),
      ]),
    ];
    for (const symbol of groupSymbols) {
      if (strategy.market === "crypto") continue;
      const factsFor = facts.industries
        ?.filter(
          (f) =>
            f.symbol === symbol &&
            ((f.basis === "current" &&
              strategy.overlay!.industryBasis === "current-labelled") ||
              (f.date <= date && f.availableAt <= date)),
        )
        .sort(
          (a, b) =>
            b.date.localeCompare(a.date) ||
            b.availableAt.localeCompare(a.availableAt),
        );
      const fact = factsFor?.[0];
      const groups =
        fact?.groups === undefined
          ? fact?.industry && fact.industry !== "未知"
            ? [fact.industry]
            : []
          : [...new Set(fact.groups)].filter((g) => g && g !== "未知").sort();
      if (!fact || !groups.length)
        return unavailable("Missing causal industry grouping");
      const second = factsFor?.[1],
        secondGroups =
          second?.groups ?? (second?.industry ? [second.industry] : []);
      if (
        second?.date === fact.date &&
        second.availableAt === fact.availableAt &&
        JSON.stringify([...new Set(secondGroups)].sort()) !==
          JSON.stringify(groups)
      )
        return unavailable("Conflicting industry grouping facts");
      sectors.set(symbol, groups);
      if (fact.basis === "current")
        biasTags.push(`current-industry-lookahead:${fact.source}`);
    }
    industries = Object.fromEntries(
      [...sectors].map(([symbol, groups]) => [symbol, [...groups]]),
    );
    if (strategy.overlay.industryWeight !== undefined)
      for (const sector of new Set([...sectors.values()].flat())) {
        const symbols = groupSymbols.filter((symbol) =>
            sectors.get(symbol)?.includes(sector),
          ),
          total = symbols.reduce((n, s) => n + addedWeight(s), 0);
        const prior = rebalance
          ? 0
          : holdings
              .filter((h) => symbols.includes(h.symbol))
              .reduce((n, h) => n + h.weight, 0);
        const room = Math.max(0, strategy.overlay.industryWeight - prior);
        if (total > room) limitAdditions(symbols, room / total);
      }
    if (strategy.overlay.correlationGroupRisk !== undefined) {
      const vectors = new Map(
        groupSymbols.map((symbol) => [symbol, riskAt(symbol)]),
      );
      const grouped = researchCorrelationGroups(
        groupSymbols,
        vectors,
        sectors,
        strategy.overlay.correlationThreshold,
      );
      if (grouped.reason) return unavailable(grouped.reason);
      riskGroups = grouped.groups;
      for (const members of grouped.groups) {
        const total = members.reduce(
          (n, s) => n + addedWeight(s) * (risks.get(s) ?? 0),
          0,
        );
        const prior = rebalance
          ? 0
          : holdings
              .filter((h) => members.includes(h.symbol))
              .reduce((n, h) => n + h.openRisk!, 0);
        const room = Math.max(0, strategy.overlay.correlationGroupRisk - prior);
        if (total > room) limitAdditions(members, room / total);
      }
    }
  }
  if (rebalance) {
    state.baseTargets = { ...weights };
    state.admissionScale = existingScale;
    state.industries = industries;
    state.riskGroups = riskGroups;
    state.riskAsOf = date;
  }
  for (const symbol of Object.keys(weights))
    weights[symbol] = Math.max(
      otherWeight(symbol),
      weights[symbol]! * (rebalance ? existingScale : 1),
    );
  exposure = Object.values(weights).reduce((n, w) => n + w, 0);
  const ownTargets = Object.fromEntries(
    Object.entries(weights).map(([symbol, weight]) => [
      symbol,
      Math.max(0, weight - otherWeight(symbol)),
    ]),
  );
  if (rebalance && admissionScale === 0)
    for (const symbol of Object.keys(ownTargets))
      ownTargets[symbol] = Math.min(ownTargets[symbol]!, ownWeight(symbol));
  const targets = rebalance
    ? ownTargets
    : holdings.some(
          (h) =>
            h.managed !== false &&
            (ownTargets[h.symbol] ?? h.weight) < ownWeight(h.symbol),
        )
      ? Object.fromEntries(
          holdings
            .filter((h) => h.managed !== false)
            .map((h) => [
              h.symbol,
              Math.min(
                ownWeight(h.symbol),
                ownTargets[h.symbol] ?? ownWeight(h.symbol),
              ),
            ]),
        )
      : null;
  exposure =
    Object.values(ownTargets).reduce((n, weight) => n + weight, 0) +
    holdings
      .filter((h) => h.managed === false)
      .reduce((n, h) => n + h.weight, 0);
  return {
    date,
    available: regimeMissing === null,
    reason:
      regimeMissing ??
      (rebalance && admissionScale === 0 && existingScale > 0
        ? "DD admission pause: normal weekly exits remain active; all positive target deltas are blocked"
        : null),
    exposure,
    state,
    regime,
    estimatedVolatility,
    ...(baseTargets ? { baseTargets } : {}),
    ...(excludedBaseTargets?.length ? { excludedBaseTargets } : {}),
    ...(biasTags.length ? { biasTags: [...new Set(biasTags)] } : {}),
    ...(riskGroups ? { riskGroups } : {}),
    ...(industries ? { industries } : {}),
    ...(riskGroups || industries ? { riskAsOf: date } : {}),
    entries: selected
      .filter(
        (c) =>
          admissionScale > 0 &&
          (rebalance
            ? ownTargets[c.symbol]! > ownWeight(c.symbol)
            : c.decision.entry === true &&
              c.decision.exit !== true &&
              ownTargets[c.symbol]! > ownWeight(c.symbol)),
      )
      .map((c) => ({
        symbol: c.symbol,
        score: c.score,
        weight: ownTargets[c.symbol]!,
        currentWeight: ownWeight(c.symbol),
        deltaWeight: ownTargets[c.symbol]! - ownWeight(c.symbol),
        ...(strategy.rank?.kind === "rps-composite"
          ? {
              rps: strategy.rank.periods.map((period) => {
                const point = c.external?.rps?.find((p) => p.date === date);
                return {
                  period,
                  actual: point?.values[point.periods.indexOf(period)] ?? null,
                };
              }),
            }
          : {}),
      })),
    targets,
    adjustments: adjustmentsFor(targets),
    regimeEffect: rebalance ? "exposure-switch" : "entry-gate",
    entryAdmissionScale: admissionScale,
    existingExposureScale: existingScale,
    ...(marketTargetShare !== undefined ? { marketTargetShare } : {}),
    ...(lowMarket ? { marketLowZone: lowMarket } : {}),
  };
}
