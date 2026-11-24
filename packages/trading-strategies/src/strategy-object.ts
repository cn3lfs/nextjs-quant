import {
  preparePatternBreakout,
  patternBreakoutKinds,
} from "./pattern-breakout.js";
import {
  chanSignalCodes,
  classifyCzscSignals,
  type ChanSignalCode,
} from "./research/chan/chan-signal-evaluator.js";
import type { CzscResult } from "./research/chan/czsc.js";
import {
  createTripleScreenRule,
  tripleScreenVariants,
  type TripleScreenInput,
  type TripleScreenPosition,
} from "./theory-multiperiod.js";
import { studyStrategies, studyWarmup } from "./study-catalog.js";
import { createExtendedStudyRule } from "./study-rules.js";
import {
  createUtcOrbRule,
  type UtcOrbDecision,
  type UtcOrbInput,
} from "./theory-orb.js";
import { z } from "zod";
import { strategyBuildHash } from "./build-identity.js";
import { periods, type Bar } from "trading-strategy-core/bars";
import { calculateFactor } from "trading-strategy-core/factors";
import { rollingHigh } from "trading-strategy-core/indicators";
import {
  factorStrategySchema,
  factorStrategySignals,
} from "./factor-strategy.js";
import { cryptoDualMa } from "./crypto-dual-ma.js";
import {
  historicalLowConfigSchema,
  historicalLowSeries,
  type LowZoneFact,
} from "./historical-low.js";
import {
  analyzeBreakout,
  prepareBreakout,
  doubleBreakoutFilterSchema,
  evaluateBreakoutFilter,
} from "./research/breakout/breakout.js";
import { metrics } from "./research/technical/screening-metrics.js";
import {
  evaluateFormula,
  type FormulaRpsPoint,
} from "./formula/tdx-formula.js";
import { validateScreenFormula } from "./formula/formula-screen.js";
import {
  strategyRankSchema,
  strategyRegimeSchema,
  strategyOverlaySchema,
  strategyRebalanceSchema,
} from "./strategy-book-model.js";
import {
  createNativeStudyRule,
  createNativeChanProfileRule,
  nativeChanProfiles,
  nativeStudyDefinition,
  resolveNativeChanFirstIndex,
  type NativeChanProfile,
  type FrozenChanObservation,
} from "./native-study.js";

const fraction = z.number().finite().gt(0).max(1);
// Full-market scans repeat the same immutable date labels millions of times.
// Cache only validation of strings, never a caller's mutable bars or decisions.
const validDates = new Set<string>();
function validDate(date: string) {
  if (validDates.has(date)) return true;
  if (!Number.isFinite(Date.parse(date))) return false;
  if (validDates.size >= 65536) validDates.clear();
  validDates.add(date);
  return true;
}
export const strategyRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("triple-screen"),
      variant: z.enum(tripleScreenVariants),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("study-rule"),
      strategy: z.enum(studyStrategies),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("utc-orb"),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("historical-low"),
      side: z.enum(["entry", "exit"]),
      config: historicalLowConfigSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("formula"),
      source: z.string().min(1).max(100000),
      parameters: z.record(z.number().finite()).default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dual-ma"),
      fast: z.number().int().positive(),
      slow: z.number().int().positive(),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("factor"),
      strategy: factorStrategySchema,
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pattern-breakout"),
      patterns: z.array(z.enum(patternBreakoutKinds)).min(1),
      direction: z.enum(["long", "short", "both"]).default("long"),
      side: z.enum(["entry", "exit"]).default("entry"),
      minVolumeRatio: z.number().finite().nonnegative().default(1.2),
      minScore: z.number().int().min(1).max(5).default(2),
      useStructureStop: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("double-breakout"),
      filter: doubleBreakoutFilterSchema.optional(),
      useStructureStop: z.boolean().optional(),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("rps"),
      period: z.number().int().positive(),
      minimum: z.number().finite().min(0).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chan-third-buy"),
      firstIndex: z.number().int().min(140).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("chan-native"),
      profile: z.enum(nativeChanProfiles),
      side: z.enum(["entry", "exit"]),
      firstIndex: z.number().int().min(140).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("constant"), value: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("czsc-monitor"),
      codes: z.array(z.enum(chanSignalCodes)).min(1).optional(),
      direction: z.enum(["long", "short", "both"]).optional(),
      minQuality: z.union([z.literal(1), z.literal(2)]).optional(),
      config: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("screening-metrics"),
      fast: z.number().int().positive(),
      slow: z.number().int().positive(),
      minChange: z.number().finite(),
      maxChange: z.number().finite(),
      minVolumeRatio: z.number().finite().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      id: z.string().min(1),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
]);
export const strategyObjectSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    market: z.enum(["cn-equity", "crypto"]),
    period: z.enum(periods),
    universe: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("symbols"),
          symbols: z.array(z.string().min(1)).min(1),
        })
        .strict(),
      z.object({ kind: z.literal("all-market") }).strict(),
      z.object({ kind: z.literal("index"), id: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("pool"), id: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal("rps"),
          period: z.number().int().positive(),
          minimum: z.number().min(0).max(100),
        })
        .strict(),
    ]),
    entry: strategyRuleSchema,
    rank: strategyRankSchema.optional(),
    regime: strategyRegimeSchema.optional(),
    overlay: strategyOverlaySchema.optional(),
    rebalance: strategyRebalanceSchema.optional(),
    costFilter: z
      .object({
        atrPeriod: z.number().int().min(2).max(500),
        minimumMoveToCost: z.number().finite().positive(),
      })
      .strict()
      .optional(),
    exit: z
      .object({
        rule: strategyRuleSchema.optional(),
        stop: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("fixed"), fraction }).strict(),
            z
              .object({
                kind: z.literal("atr"),
                period: z.number().int().positive(),
                multiple: z.number().finite().positive(),
              })
              .strict(),
            z
              .object({
                kind: z.literal("structure"),
                field: z.string().min(1),
              })
              .strict(),
          ])
          .optional(),
        takeProfit: fraction.optional(),
        trailing: fraction.optional(),
        maxBars: z.number().int().positive().optional(),
        chandelier: z
          .object({
            period: z.number().int().min(2).max(500),
            multiple: z.number().finite().positive(),
          })
          .strict()
          .optional(),
        timeReentry: z
          .object({
            cooldownBars: z.number().int().nonnegative(),
            requireNewSignal: z.boolean(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    sizing: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("risk"),
          fraction,
          tranches: z.number().int().min(1).max(100).default(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("equal"),
          positions: z.number().int().positive(),
          tranches: z.number().int().min(1).max(100).default(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal("weight"),
          weight: fraction,
          tranches: z.number().int().min(1).max(100).default(1),
        })
        .strict(),
    ]),
    sleeve: z.string().min(1),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.market === "cn-equity" && ["1h", "4h"].includes(s.period))
      ctx.addIssue({ code: "custom", message: "Unsupported equity period" });
    for (const r of [s.entry, s.exit.rule]) {
      if (
        r?.kind === "triple-screen" &&
        s.period !== (r.variant === "week-day" ? "day" : "5m")
      )
        ctx.addIssue({
          code: "custom",
          message: "Triple screen execution period does not match its variant",
        });
      if (r?.kind === "study-rule" && s.period !== "day")
        ctx.addIssue({
          code: "custom",
          message: "Study rules require completed daily bars",
        });
      if (r?.kind === "dual-ma" && r.fast >= r.slow)
        ctx.addIssue({
          code: "custom",
          message: "fast must be smaller than slow",
        });
      if (
        (r?.kind === "double-breakout" || r?.kind === "pattern-breakout") &&
        s.period !== "day"
      )
        ctx.addIssue({
          code: "custom",
          message: `${r.kind} requires daily bars`,
        });
      if (r?.kind === "utc-orb" && (s.market !== "crypto" || s.period !== "5m"))
        ctx.addIssue({
          code: "custom",
          message: "UTC ORB requires crypto 5m bars (no CN T+1 variant)",
        });
    }
    if (s.entry.kind === "utc-orb" || s.exit.rule?.kind === "utc-orb") {
      if (
        s.entry.kind !== "utc-orb" ||
        s.exit.rule?.kind !== "utc-orb" ||
        s.entry.side !== "entry" ||
        s.exit.rule.side !== "exit"
      )
        ctx.addIssue({
          code: "custom",
          message: "UTC ORB requires matching entry and exit rules",
        });
      if (
        s.universe.kind !== "symbols" ||
        s.universe.symbols.some(
          (symbol) => !["cxBTCUSDT", "cxETHUSDT"].includes(symbol),
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "UTC ORB universe is BTC/ETH spot only",
        });
    }
    if (
      s.entry.kind === "triple-screen" ||
      s.exit.rule?.kind === "triple-screen"
    ) {
      if (
        s.entry.kind !== "triple-screen" ||
        s.exit.rule?.kind !== "triple-screen" ||
        s.entry.variant !== s.exit.rule.variant ||
        s.entry.side !== "entry" ||
        s.exit.rule.side !== "exit"
      )
        ctx.addIssue({
          code: "custom",
          message: "Triple screen requires matching entry and exit variants",
        });
    }
    if (s.sizing.kind === "risk" && !s.exit.stop)
      ctx.addIssue({
        code: "custom",
        message: "risk sizing requires an initial stop",
      });
    if (s.rebalance && (!s.rank || s.period !== "day"))
      ctx.addIssue({
        code: "custom",
        message:
          "Ranked weekly books require a daily strategy and an explicit rank",
      });
    if (s.rank?.kind === "classic" && !s.rebalance)
      ctx.addIssue({
        code: "custom",
        message: "Classic cross-sectional ranking requires a ranked book",
      });
    if (s.exit.timeReentry && s.exit.maxBars === undefined)
      ctx.addIssue({
        code: "custom",
        message: "Time re-entry requires an explicit time exit",
      });
  });
export type StrategyObject = z.infer<typeof strategyObjectSchema>;
export type StrategyObjectInput = z.input<typeof strategyObjectSchema>;
export type StrategyRule = z.infer<typeof strategyRuleSchema>;
export type StrategyRuleEvidence = {
  kind: StrategyRule["kind"];
  bar: string;
  basis: "signal-bars";
  close: number;
  volume: number;
  entry: boolean | null;
  inputs: Record<string, unknown>;
  rps?: { period: number; actual: FormulaRpsPoint["values"][number] | null }[];
};
/** Full-history rule output, prepared by the same implementation before a
 * bounded replay drops pre-start OHLC. Price levels are ALWAYS signal-basis;
 * execution converts them to raw exactly once at the observed bar. */
export type PreparedStrategyRule = {
  strategy: StrategyObjectInput;
  definitionHash: string;
  buildHash: string;
  strategyBuildHash: string;
  priceBasis: "signal";
  sourceHashes: Readonly<Record<string, string>>;
  points: readonly {
    date: string;
    availableAt: string;
    sourceHashes: Readonly<Record<string, string>>;
    decision: StrategyDecision;
    evidence: StrategyRuleEvidence;
  }[];
};
export type StrategyExternalInputs = {
  tripleScreen?: TripleScreenInput;
  orb?: UtcOrbInput;
  preparedRules?: readonly PreparedStrategyRule[];
  lowZone?: readonly LowZoneFact[];
  monitorCzsc?: {
    observations: readonly MonitorCzscObservation[];
    /** Full native projection used to produce the current alert observations. */
    result?: CzscResult;
    /** Native snapshots keyed by the completed observation date, indexed against signal bars. */
    snapshots?: Readonly<Record<string, CzscResult>>;
    seenKeys?: readonly string[];
  };
  signals?: readonly {
    id: string;
    date: string;
    availableAt: string;
    entry: boolean | null;
    exit: boolean | null;
  }[];
  rps?: readonly FormulaRpsPoint[];
  chan?: readonly FrozenChanObservation[];
  levels?: readonly {
    date: string;
    availableAt: string;
    field: string;
    value: number;
  }[];
};
export type MonitorCzscObservation = {
  date: string;
  availableAt: string;
  endpointDate: string;
  code?: ChanSignalCode;
  revokedAt?: number;
  config: number;
  key: string;
  kind: number;
  quality: number;
};
/** Record confirmation on the observation bar while retaining the historical endpoint. */
export function classifiedMonitorObservations(
  result: CzscResult,
  bars: readonly Bar[],
  index: number,
) {
  const date = bars[index]!.date;
  return classifyCzscSignals(result, bars, { asOfIndex: index })
    .filter((signal) => signal.confirmedAt === index)
    .map((signal) => ({
      ...signal,
      date,
      availableAt: date,
      endpointDate: signal.date,
      kind: 0,
    }));
}
/** Observation date is the completed bar; the native endpoint may be historical. */
export function selectCzscMonitorSignals(
  observations: readonly MonitorCzscObservation[],
  config: number,
  asOf: string,
  seenKeys?: readonly string[],
) {
  if (
    observations.some(
      (row) =>
        !Number.isFinite(Date.parse(row.availableAt)) ||
        row.availableAt > row.date ||
        row.endpointDate > row.date,
    )
  )
    throw new Error("Invalid / non-causal native monitor observation");
  const qualified = observations.filter(
    (row) =>
      row.date === asOf &&
      row.config === config &&
      [1, 2].includes(row.quality) &&
      (row.revokedAt === undefined || row.revokedAt < 0) &&
      (row.code !== undefined || [1, 2, 3].includes(Math.abs(row.kind))),
  );
  const seen = new Set(seenKeys);
  return {
    qualified,
    fresh: seenKeys ? qualified.filter((row) => !seen.has(row.key)) : [],
  };
}
export type StrategyDecision = {
  entry: boolean | null;
  exit: boolean | null;
  exitFraction?: number;
  stopLevel: number | null;
  chandelierStop?: number | null;
};

export type StrategyReentryState = { exitBar: number; sawFalse: boolean };
export function strategyReentryAllowed(
  exit: StrategyObjectInput["exit"],
  state: StrategyReentryState | undefined,
  bar: number,
  entry: boolean | null,
) {
  if (!exit.timeReentry || !state) return true;
  return (
    bar > state.exitBar + exit.timeReentry.cooldownBars &&
    (!exit.timeReentry.requireNewSignal || state.sawFalse) &&
    entry === true
  );
}

/** Called after protection checks: this completed bar changes the NEXT bar's stop. */
export function nextStrategyProtection(
  exit: StrategyObjectInput["exit"],
  position: { stop: number | null; high: number },
  bar: Pick<Bar, "high">,
  chandelierStop?: number | null,
) {
  const high = Math.max(position.high, bar.high);
  const stop = Math.max(
    position.stop ?? 0,
    exit.trailing ? high * (1 - exit.trailing) : 0,
    exit.chandelier && chandelierStop != null && Number.isFinite(chandelierStop)
      ? chandelierStop
      : 0,
  );
  return { high, stop: stop > 0 ? stop : null };
}

export function strategyTimeExit(
  exit: StrategyObjectInput["exit"],
  completedHoldingBars: number,
) {
  return exit.maxBars !== undefined && completedHoldingBars >= exit.maxBars;
}

export function standingProtectionLevels(
  exit: StrategyObjectInput["exit"],
  position: { stop: number | null; target: number | null; high: number },
) {
  const trailing = exit.trailing ? position.high * (1 - exit.trailing) : null;
  return {
    stop: Math.max(position.stop ?? 0, trailing ?? 0),
    trailing,
    target: position.target,
  };
}

/** Protection was known before this completed bar; stop wins an ambiguous OHLC path. */
export function strategyProtection(
  strategy: Pick<StrategyObjectInput, "exit">,
  bar: Bar,
  position: { stop: number | null; target: number | null; high: number },
): { trigger: "stop" | "trailing" | "target"; price: number } | null {
  const levels = standingProtectionLevels(strategy.exit, position);
  const trail = levels.trailing;
  const stop = levels.stop;
  if (stop > 0 && bar.low <= stop)
    return {
      trigger:
        trail !== null && trail > (position.stop ?? 0) ? "trailing" : "stop",
      price: Math.min(bar.open, stop),
    };
  if (position.target !== null && bar.high >= position.target)
    return { trigger: "target", price: Math.max(bar.open, position.target) };
  return null;
}

/** Compile once per frozen series. Formula static checks run even with no bars.
 * Point evaluation never sees a future prefix in a native rule or structural input.
 * Price basis and forward-adjustment denominator are frozen by the caller.
 */
export function validateStrategyBars(bars: readonly Bar[]) {
  let previous = "";
  for (const b of bars) {
    if (
      b.date <= previous ||
      !validDate(b.date) ||
      !Number.isFinite(b.open) ||
      b.open <= 0 ||
      !Number.isFinite(b.high) ||
      b.high <= 0 ||
      !Number.isFinite(b.low) ||
      b.low <= 0 ||
      !Number.isFinite(b.close) ||
      b.close <= 0 ||
      !Number.isFinite(b.volume) ||
      b.volume < 0 ||
      !Number.isFinite(b.amount) ||
      b.amount < 0 ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close)
    )
      throw new Error("Invalid strategy bars / order");
    previous = b.date;
  }
}

export function prepareStrategy(
  raw: StrategyObjectInput,
  bars: readonly Bar[],
  external: StrategyExternalInputs = {},
) {
  const strategy = strategyObjectSchema.parse(raw);
  validateStrategyBars(bars);
  if (
    new Set(external.rps?.map((x) => x.date)).size !==
    (external.rps?.length ?? 0)
  )
    throw new Error("Duplicate RPS observations");
  if (
    external.preparedRules &&
    (strategy.entry.kind === "study-rule" ||
      strategy.exit.rule?.kind === "study-rule" ||
      strategy.entry.kind === "triple-screen" ||
      strategy.exit.rule?.kind === "triple-screen" ||
      strategy.entry.kind === "utc-orb" ||
      strategy.exit.rule?.kind === "utc-orb")
  )
    throw new Error(
      "Position-dependent study rules cannot use projected observations",
    );
  if (external.preparedRules) {
    const sameId = external.preparedRules.filter(
      (row) => row.strategy.id === strategy.id,
    );
    const rule = sameId[0];
    const canonical = (value: unknown): string =>
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
            )
          : item,
      );
    const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
    if (
      sameId.length !== 1 ||
      !rule ||
      canonical(strategyObjectSchema.parse(rule.strategy)) !==
        canonical(strategy) ||
      rule.strategyBuildHash !== strategyBuildHash ||
      rule.priceBasis !== "signal" ||
      !digest(rule.definitionHash) ||
      !digest(rule.buildHash) ||
      !Object.keys(rule.sourceHashes).length ||
      !Object.values(rule.sourceHashes).every(digest) ||
      rule.points.some(
        (point, i) =>
          !validDate(point.date) ||
          !validDate(point.availableAt) ||
          !Object.keys(point.sourceHashes ?? {}).length ||
          !Object.values(point.sourceHashes ?? {}).every(digest) ||
          point.availableAt > point.date ||
          (i > 0 && point.date <= rule.points[i - 1]!.date) ||
          ![true, false, null].includes(point.decision.entry) ||
          ![true, false, null].includes(point.decision.exit) ||
          point.decision.stopLevel === undefined ||
          (strategy.exit.chandelier !== undefined &&
            point.decision.chandelierStop === undefined) ||
          [point.decision.stopLevel, point.decision.chandelierStop].some(
            (v) => v !== undefined && v !== null && !Number.isFinite(v),
          ) ||
          point.evidence.bar !== point.date ||
          !Number.isFinite(point.evidence.close) ||
          point.evidence.close <= 0 ||
          !Number.isFinite(point.evidence.volume) ||
          point.evidence.volume < 0 ||
          point.evidence.basis !== "signal-bars" ||
          point.evidence.kind !== strategy.entry.kind,
      )
    )
      throw new Error(
        "Invalid / mismatched genuine strategy rule observations",
      );
    const points = new Map(rule.points.map((point) => [point.date, point]));
    const observed = (index: number) => {
      if (!Number.isInteger(index) || index < 0 || index >= bars.length)
        throw new Error("Invalid strategy index");
      const bar = bars[index]!,
        point = points.get(bar.date);
      if (
        point &&
        (point.evidence.close !== bar.close ||
          point.evidence.volume !== bar.volume)
      )
        throw new Error(
          "Genuine rule price basis differs from aligned signal bar",
        );
      return { bar, point };
    };
    return {
      strategy,
      breakoutAt: (_index: number): ReturnType<typeof analyzeBreakout> => {
        throw new Error(
          "Full breakout history is not retained in a prepared rule point",
        );
      },
      explain(index: number): StrategyRuleEvidence {
        const { bar, point } = observed(index);
        return (
          point?.evidence ?? {
            kind: strategy.entry.kind,
            bar: bar.date,
            basis: "signal-bars",
            close: bar.close,
            volume: bar.volume,
            entry: null,
            inputs: {
              missing: "Missing genuine full-history rule observation",
            },
          }
        );
      },
      evaluate(index: number): StrategyDecision {
        const { point } = observed(index);
        if (!point)
          throw new Error("Missing genuine full-history rule observation");
        return { ...point.decision };
      },
    };
  }
  const breakoutCache = new Map<number, ReturnType<typeof analyzeBreakout>>();
  let breakoutPrepared: ReturnType<typeof prepareBreakout> | undefined;
  const lowCache = new Map<string, ReturnType<typeof historicalLowSeries>>();
  const formulaEvidence = new Map<
    StrategyRule,
    ReturnType<typeof evaluateFormula>["outputs"]
  >();
  const breakoutAt = (i: number) => {
    if (!breakoutCache.has(i)) {
      // Only one point is retained; historical playback must not retain O(n²) analyses.
      breakoutCache.clear();
      breakoutPrepared ??= prepareBreakout(bars);
      const latest = breakoutPrepared.point(i);
      breakoutCache.set(i, {
        version: breakoutPrepared.version,
        method: breakoutPrepared.method,
        points: [latest],
        latest,
      });
    }
    return breakoutCache.get(i)!;
  };
  type BreakoutRule = Extract<StrategyRule, { kind: "double-breakout" }>;
  const doubleAt = (rule: BreakoutRule, index: number) => {
    const point = breakoutAt(index).points[0]!;
    const direction = rule.side === "entry" ? "long" : "short";
    const result = evaluateBreakoutFilter(point, bars[index]!, {
      ...rule.filter,
      direction,
    });
    const sides = [point[direction]];
    const decision =
      result.matched ||
      (sides.some((side) => side.status === "未知") ? null : false);
    return {
      ...result,
      decision,
      sides,
      volumeRatio: point.volumeRatio,
      volume20: point.volume20,
      missing: point.missing,
    };
  };
  type PatternRule = Extract<StrategyRule, { kind: "pattern-breakout" }>;
  const patternCache = new Map<
    PatternRule,
    ReturnType<typeof preparePatternBreakout>
  >();
  const patternAt = (rule: PatternRule, index: number) => {
    let prepared = patternCache.get(rule);
    if (!prepared) {
      prepared = preparePatternBreakout(bars, {
        ...rule,
        kinds: rule.patterns,
      });
      patternCache.set(rule, prepared);
    }
    return prepared.at(index);
  };
  const monitorAt = (
    rule: Extract<StrategyRule, { kind: "czsc-monitor" }>,
    index: number,
  ) => {
    const facts = external.monitorCzsc;
    if (!facts) throw new Error("Missing native monitor observations");
    const date = bars[index]!.date;
    const snapshot = facts.snapshots?.[date];
    const observations = snapshot
      ? classifiedMonitorObservations(snapshot, bars, index)
      : facts.observations;
    const selection = selectCzscMonitorSignals(
      observations,
      rule.config,
      date,
      facts.seenKeys,
    );
    const fresh = selection.fresh.filter((row) => {
      const code =
        row.code ??
        (`${Math.abs(row.kind)}${row.kind > 0 ? "B" : "S"}` as ChanSignalCode);
      const direction = code.endsWith("B") ? "long" : "short";
      return (
        (!rule.codes || rule.codes.includes(code)) &&
        (!rule.direction ||
          rule.direction === "both" ||
          rule.direction === direction) &&
        row.quality >= (rule.minQuality ?? 1)
      );
    });
    return {
      config: rule.config,
      fresh,
      baseline: facts.seenKeys === undefined,
      matched: bars[index]!.volume > 0 && fresh.length > 0,
    };
  };
  const multiEvidence = new Map<
    StrategyRule,
    (
      index: number,
      position?: TripleScreenPosition,
    ) => ReturnType<ReturnType<typeof createTripleScreenRule>>
  >();
  const orbEvidence = new Map<
    StrategyRule,
    (index: number, position?: TripleScreenPosition) => UtcOrbDecision
  >();
  const nativeRules = new Map<
    NativeChanProfile,
    { first: number; evaluate: ReturnType<typeof createNativeChanProfileRule> }
  >();
  let inferredFirst: number | undefined;
  const nativeFeed = () => {
    if (!external.chan?.length)
      throw new Error("Missing serial native observations");
    return external.chan;
  };
  const firstNativeBar = () =>
    (inferredFirst ??= resolveNativeChanFirstIndex(bars, nativeFeed()));
  const compile = (
    rule: StrategyRule,
    executionSide: "entry" | "exit" = "entry",
  ): ((
    index: number,
    position?: TripleScreenPosition,
    exitDetails?: Pick<StrategyDecision, "exitFraction">,
  ) => boolean | null) => {
    switch (rule.kind) {
      case "triple-screen": {
        const input = external.tripleScreen;
        if (
          !input ||
          input.variant !== rule.variant ||
          input.market !== strategy.market
        )
          throw new Error("Missing or mismatched multi-period input");
        const execution = input.execution.slots;
        for (const slot of execution) {
          if (!slot.bar) continue;
          const closeTime =
            strategy.period === "day"
              ? strategy.market === "cn-equity"
                ? Date.parse(`${slot.bar.date.slice(0, 10)}T15:00:00+08:00`)
                : Date.parse(slot.bar.date.slice(0, 10)) + 86400000
              : Date.parse(slot.bar.date);
          if (Date.parse(slot.availableAt) !== closeTime)
            throw new Error(
              "Execution availability must match completed bar clock",
            );
        }

        const present = execution.flatMap((slot, index) =>
          slot.bar ? [{ bar: slot.bar, index }] : [],
        );
        if (
          present.length !== bars.length ||
          present.some((slot, i) =>
            (
              [
                "date",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "amount",
              ] as const
            ).some((key) => slot.bar[key] !== bars[i]![key]),
          )
        )
          throw new Error(
            "Multi-period execution bars must equal strategy signal bars",
          );
        const slotIndex = (index: number) => {
          const point = present[index];
          if (!point) throw new Error("Missing multi-period position index");
          return point.index;
        };
        const evaluate = createTripleScreenRule(input);
        const mapped = (i: number, position?: TripleScreenPosition) =>
          evaluate(
            slotIndex(i),
            position
              ? {
                  ...position,
                  entryIndex: slotIndex(position.entryIndex),
                  ...(position.signalIndex === undefined
                    ? {}
                    : { signalIndex: slotIndex(position.signalIndex) }),
                  ...(position.lastExitIndex === undefined
                    ? {}
                    : {
                        lastExitIndex:
                          position.lastExitIndex === -1
                            ? -1
                            : slotIndex(position.lastExitIndex),
                      }),
                }
              : { entry: 0, entryIndex: slotIndex(i) },
          );
        multiEvidence.set(rule, mapped);
        return (i, position) => {
          const decision = mapped(i, position);
          if (rule.side === "entry")
            return decision.entryKnown ? decision.enter : null;
          return decision.exitKnown ? decision.exit : null;
        };
      }

      case "utc-orb": {
        const orb = external.orb;
        if (!orb) throw new Error("Missing frozen UTC ORB completed 5m input");
        if (strategy.period !== "5m" || strategy.market !== "crypto")
          throw new Error("UTC ORB requires crypto 5m execution bars");
        const evaluate = createUtcOrbRule(orb, bars);
        orbEvidence.set(rule, evaluate);
        return (i, position) => {
          const decision = evaluate(i, position ?? { entry: 0, entryIndex: i });
          return rule.side === "entry"
            ? decision.entryKnown
              ? decision.entry
              : null
            : decision.exitKnown
              ? decision.exit
              : null;
        };
      }

      case "study-rule": {
        const evaluate = createExtendedStudyRule(rule.strategy, bars);
        if (!evaluate)
          throw new Error(
            "Study rule requires an account-only execution profile",
          );
        return (i, position, exitDetails) => {
          if (i < studyWarmup(rule.strategy)) return null;
          if (rule.side === "exit" && !position) return false;
          const output = evaluate(i, position ?? { entry: 0, entryIndex: i });
          if (rule.side === "entry") return output.enter;
          if (exitDetails && output.exitFraction !== undefined)
            exitDetails.exitFraction = output.exitFraction;
          return output.exit;
        };
      }
      case "historical-low": {
        const key = JSON.stringify(rule.config);
        if (!lowCache.has(key))
          lowCache.set(
            key,
            historicalLowSeries(bars, rule.config, external.lowZone),
          );
        const rows = lowCache.get(key)!;
        return (i) =>
          rule.side === "exit"
            ? rows[i]!.recovery
            : rows[i]!.depth === null
              ? null
              : rows[i]!.depth! > 0 &&
                rows[i]!.depth! > (rows[i - 1]?.depth ?? 0);
      }
      case "constant":
        return () => rule.value;
      case "czsc-monitor":
        return (i) => monitorAt(rule, i).matched;
      case "screening-metrics":
        return (i) => metrics(bars.slice(0, i + 1), rule)?.matched ?? null;
      case "external": {
        const rows = external.signals?.filter((s) => s.id === rule.id) ?? [];
        if (
          new Set(rows.map((s) => s.date)).size !== rows.length ||
          rows.some(
            (s) =>
              s.availableAt > s.date ||
              !Number.isFinite(Date.parse(s.availableAt)),
          )
        )
          throw new Error("Invalid / non-causal external signal");
        const signals = new Map(rows.map((s) => [s.date, s]));
        return (i) => signals.get(bars[i]!.date)?.[rule.side] ?? null;
      }
      case "formula": {
        validateScreenFormula({
          name: "strategy",
          source: rule.source,
          parameters: rule.parameters,
        });
        const outputs = evaluateFormula(
          rule.source,
          bars,
          rule.parameters,
          external.rps,
        ).outputs;
        formulaEvidence.set(rule, outputs);
        const values = outputs[0]!.values;
        return (i) => (values[i] == null ? null : values[i] !== 0);
      }
      case "factor": {
        const values = factorStrategySignals(bars, rule.strategy).values;
        return (i) => values[i] === (rule.side === "entry" ? 1 : -1);
      }
      case "dual-ma":
        return (i) => {
          const result = cryptoDualMa(
            bars.slice(Math.max(0, i - rule.slow), i + 1).map((b) => b.close),
            rule.fast,
            rule.slow,
          );
          return result === null
            ? null
            : result.signal === (rule.side === "entry" ? "BUY" : "SELL");
        };
      case "double-breakout":
        return (i) => doubleAt(rule, i).decision;
      case "pattern-breakout":
        return (i) =>
          patternAt(rule, i).some(
            (match) =>
              match.direction ===
              (executionSide === "entry" ? "long" : "short"),
          );
      case "rps":
        return (i) => {
          const point = external.rps?.find((x) => x.date === bars[i]!.date);
          const value = point?.values[point.periods.indexOf(rule.period)]?.rps;
          return value == null ? null : value >= rule.minimum;
        };
      case "chan-third-buy": {
        let validated: ReturnType<typeof createNativeStudyRule> | undefined;
        return (i) => {
          if (i < nativeStudyDefinition.warmupBars - 1) return null;
          const first = rule.firstIndex ?? firstNativeBar();
          if (i < first - 1) return null;
          if (i === first - 1) return false;
          if (!validated) {
            if (!external.chan)
              throw new Error("Missing serial native observations");
            validated = createNativeStudyRule(bars, first, external.chan);
          }
          return validated(i, { entry: 0, entryIndex: 0 }).enter;
        };
      }
      case "chan-native":
        return (i, position) => {
          if (i < nativeStudyDefinition.warmupBars - 1) return null;
          const first = rule.firstIndex ?? firstNativeBar();
          if (i < first - 1) return null;
          let cached = nativeRules.get(rule.profile);
          if (!cached || cached.first !== first) {
            cached = {
              first,
              evaluate: createNativeChanProfileRule(
                rule.profile,
                bars,
                nativeFeed(),
                first,
              ),
            };
            nativeRules.set(rule.profile, cached);
          }
          const decision = cached.evaluate(i, position);
          return rule.side === "entry" ? decision.enter : decision.exit;
        };
    }
  };
  const enter = compile(strategy.entry, "entry"),
    leave = strategy.exit.rule
      ? compile(strategy.exit.rule, "exit")
      : () => false;
  const stop = strategy.exit.stop;
  // Index once per prepared rule; retain lazy validation at the observed bar.
  // Repeated filtering here made ATR research quadratic in history length.
  const structureLevels = new Map<
    string,
    NonNullable<StrategyExternalInputs["levels"]>[number][]
  >();
  if (stop?.kind === "structure")
    for (const level of external.levels ?? []) {
      if (level.field !== stop.field) continue;
      const rows = structureLevels.get(level.date) ?? [];
      rows.push(level);
      structureLevels.set(level.date, rows);
    }
  const atr =
    stop?.kind === "atr"
      ? calculateFactor(bars, {
          id: "atr",
          parameters: { period: stop.period },
        }).values
      : undefined;
  const chandelierAtr = strategy.exit.chandelier
    ? calculateFactor(bars, {
        id: "atr",
        parameters: { period: strategy.exit.chandelier.period },
      }).values
    : undefined;
  const chandelierHigh = strategy.exit.chandelier
    ? rollingHigh(bars, strategy.exit.chandelier.period)
    : undefined;
  return {
    strategy,
    breakoutAt,
    /** Diagnostic values come from the same rule implementations, never a second signal. */
    explain(
      index: number,
      position?: TripleScreenPosition,
    ): StrategyRuleEvidence {
      if (!Number.isInteger(index) || index < 0 || index >= bars.length)
        throw new Error("Invalid strategy index");
      const rule = strategy.entry,
        bar = bars[index]!;
      let inputs: Record<string, unknown> = {};
      if (rule.kind === "triple-screen") {
        const input = external.tripleScreen!;
        inputs = {
          variant: rule.variant,
          ...multiEvidence.get(rule)!(index, position),
          protectionBasis: "completed-close-only",
          executionSource: input.execution.sourceHash,
          setupSource: input.setup.sourceHash,
          backgroundSource: input.background.sourceHash,
          calendarHash: input.execution.calendarHash,
          adjustmentId: input.execution.adjustmentId,
        };
      } else if (rule.kind === "utc-orb") {
        const orb = external.orb!;
        inputs = {
          ...orbEvidence.get(rule)!(index, position),
          sourceHash: orb.sourceHash,
          adjustmentId: orb.adjustmentId,
          calendarHash: orb.calendarHash,
          warmupDays: orb.warmupDays,
          sessionBars: orb.sessionBars,
          model: "UTC 5分钟收盘代理；下一5分钟开盘执行；非严格日内或盘中硬止损",
        };
      } else if (rule.kind === "dual-ma")
        inputs = {
          fast: rule.fast,
          slow: rule.slow,
          ...(cryptoDualMa(
            bars
              .slice(Math.max(0, index - rule.slow), index + 1)
              .map((b) => b.close),
            rule.fast,
            rule.slow,
          ) ?? { missing: "MA warmup" }),
        };
      else if (rule.kind === "formula") {
        const expressions = [
          ...new Set(
            rule.source.match(
              /REF\(HHV\(H,\s*[\w.]+\),\s*1\)|MA\([CV],\s*[\w.]+\)/gi,
            ) ?? [],
          ),
        ];
        const dependencies = expressions.length
          ? evaluateFormula(
              expressions
                .map((expression, i) => `E${i}:${expression};`)
                .join(""),
              bars.slice(0, index + 1),
              rule.parameters,
              external.rps,
            ).outputs
          : [];
        inputs = {
          source: rule.source,
          parameters: rule.parameters ?? {},
          outputs: formulaEvidence
            .get(rule)
            ?.map((o) => ({ name: o.name, value: o.values[index] ?? null })),
          dependencies: dependencies.map((o, i) => ({
            expression: expressions[i],
            value: o.values.at(-1) ?? null,
          })),
        };
      } else if (rule.kind === "double-breakout") {
        const result = doubleAt(rule, index);
        const side = result.side ?? result.sides[0];
        inputs = {
          ...result,
          checks: side?.checks,
          line: side?.line,
          keyLevel: side?.keyLevel,
        };
      } else if (rule.kind === "pattern-breakout") {
        inputs = {
          patterns: rule.patterns,
          direction: rule.direction,
          matches: patternAt(rule, index),
        };
      } else if (rule.kind === "czsc-monitor") {
        inputs = monitorAt(rule, index);
      } else if (rule.kind === "rps") {
        const point = external.rps?.find((p) => p.date === bar.date);
        inputs = {
          period: rule.period,
          minimum: rule.minimum,
          actual: point?.values[point.periods.indexOf(rule.period)] ?? null,
        };
      } else
        inputs = {
          rule,
          ...(rule.kind === "historical-low"
            ? {
                lowZone:
                  lowCache.get(JSON.stringify(rule.config))?.[index] ?? null,
              }
            : {}),
        };
      return {
        kind: rule.kind,
        bar: bar.date,
        basis: "signal-bars" as const,
        close: bar.close,
        volume: bar.volume,
        entry: enter(index, position),
        inputs,
        ...(strategy.rank?.kind === "rps-composite"
          ? {
              rps: strategy.rank.periods.map((period) => {
                const point = external.rps?.find((p) => p.date === bar.date);
                return {
                  period,
                  actual: point?.values[point.periods.indexOf(period)] ?? null,
                };
              }),
            }
          : {}),
      };
    },
    evaluate(index: number, position?: TripleScreenPosition): StrategyDecision {
      if (!Number.isInteger(index) || index < 0 || index >= bars.length)
        throw new Error("Invalid strategy index");
      const exitDetails: Pick<StrategyDecision, "exitFraction"> = {};
      const exit = leave(index, position, exitDetails);
      let stopLevel: number | null = null;
      if (stop?.kind === "fixed")
        stopLevel = bars[index]!.close * (1 - stop.fraction);
      if (stop?.kind === "atr" && atr?.[index] != null)
        stopLevel = bars[index]!.close - atr[index]! * stop.multiple;
      if (stop?.kind === "structure") {
        const levels = structureLevels.get(bars[index]!.date) ?? [];
        if (levels.length > 1) throw new Error("Duplicate structure levels");
        const level = levels[0];
        if (
          level &&
          (level.availableAt > bars[index]!.date ||
            !Number.isFinite(level.value) ||
            level.value <= 0)
        )
          throw new Error("Non-causal / invalid structure level");
        stopLevel = level?.value ?? null;
      }
      const entry = exit === false ? enter(index, position) : false;
      const rule = strategy.entry;
      if (
        entry &&
        !stop &&
        rule.kind === "double-breakout" &&
        rule.useStructureStop !== false
      ) {
        const signal = doubleAt(rule, index);
        if (signal.direction === "long") stopLevel = signal.stopPrice;
      }
      if (
        entry &&
        !stop &&
        rule.kind === "pattern-breakout" &&
        rule.useStructureStop
      ) {
        stopLevel =
          patternAt(rule, index).find((match) => match.direction === "long")
            ?.stopPrice ?? null;
      }
      return {
        entry,
        exit,
        ...exitDetails,
        stopLevel,
        ...(strategy.exit.chandelier
          ? {
              chandelierStop:
                chandelierAtr?.[index] != null &&
                chandelierHigh?.[index] != null
                  ? chandelierHigh[index]! -
                    chandelierAtr[index]! * strategy.exit.chandelier.multiple
                  : null,
            }
          : {}),
      };
    },
  };
}

/** Compile the ORIGINAL rule on full causal history, then project only named
 * completed dates. No replacement strategy or approximate recurrence seed. */
export function prepareStrategyRulePoints(
  strategy: StrategyObjectInput,
  bars: readonly Bar[],
  external: StrategyExternalInputs,
  dates: readonly string[],
  identity: Pick<
    PreparedStrategyRule,
    "definitionHash" | "buildHash" | "sourceHashes"
  > & { observationSourceHashes?: Readonly<Record<string, string>> },
): PreparedStrategyRule {
  if (external.preparedRules)
    throw new Error(
      "Cannot prepare genuine rules from already projected observations",
    );
  if (
    strategy.entry.kind === "study-rule" ||
    strategy.exit.rule?.kind === "study-rule" ||
    strategy.entry.kind === "triple-screen" ||
    strategy.exit.rule?.kind === "triple-screen" ||
    strategy.entry.kind === "utc-orb" ||
    strategy.exit.rule?.kind === "utc-orb"
  )
    throw new Error("Position-dependent study rules cannot be projected");
  const prepared = prepareStrategy(strategy, bars, external);
  const indices = new Map(bars.map((bar, index) => [bar.date, index]));
  const points = dates.map((date) => {
    const index = indices.get(date);
    if (index === undefined)
      throw new Error(`Genuine rule date missing from full history: ${date}`);
    return {
      date,
      availableAt: date,
      sourceHashes: identity.observationSourceHashes ?? identity.sourceHashes,
      decision: prepared.evaluate(index),
      evidence: prepared.explain(index),
    };
  });
  const result: PreparedStrategyRule = {
    strategy: prepared.strategy,
    definitionHash: identity.definitionHash,
    buildHash: identity.buildHash,
    sourceHashes: identity.sourceHashes,
    strategyBuildHash,
    priceBasis: "signal",
    points,
  };
  // Validate identity, chronology and basis through the same consumer.
  prepareStrategy(strategy, bars, { ...external, preparedRules: [result] });
  return result;
}
