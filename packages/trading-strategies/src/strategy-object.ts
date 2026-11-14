import { z } from "zod";
import { periods, type Bar } from "trading-strategy-core/bars";
import { calculateFactor } from "trading-strategy-core/factors";
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
import { analyzeBreakout } from "./research/breakout/breakout.js";
import { metrics } from "./research/technical/screening-metrics.js";
import {
  evaluateFormula,
  type FormulaRpsPoint,
} from "./formula/tdx-formula.js";
import { validateScreenFormula } from "./formula/formula-screen.js";
import {
  createNativeStudyRule,
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
      kind: z.literal("double-breakout"),
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
      firstIndex: z.number().int().min(140),
    })
    .strict(),
  z.object({ kind: z.literal("constant"), value: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("czsc-monitor"),
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
      if (r?.kind === "dual-ma" && r.fast >= r.slow)
        ctx.addIssue({
          code: "custom",
          message: "fast must be smaller than slow",
        });
      if (r?.kind === "double-breakout" && s.period !== "day")
        ctx.addIssue({
          code: "custom",
          message: "double breakout requires daily bars",
        });
    }
    if (s.sizing.kind === "risk" && !s.exit.stop)
      ctx.addIssue({
        code: "custom",
        message: "risk sizing requires an initial stop",
      });
  });
export type StrategyObject = z.infer<typeof strategyObjectSchema>;
export type StrategyObjectInput = z.input<typeof strategyObjectSchema>;
export type StrategyRule = z.infer<typeof strategyRuleSchema>;
export type StrategyExternalInputs = {
  lowZone?: readonly LowZoneFact[];
  monitorCzsc?: {
    observations: readonly MonitorCzscObservation[];
    seenKeys?: readonly string[];
  };
  signals?: readonly {
    id: string;
    date: string;
    availableAt: string;
    entry: boolean;
    exit: boolean;
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
  config: number;
  key: string;
  kind: number;
  quality: number;
};
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
      [1, 2, 3].includes(Math.abs(row.kind)),
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
  stopLevel: number | null;
};

/** Protection was known before this completed bar; stop wins an ambiguous OHLC path. */
export function strategyProtection(
  strategy: StrategyObjectInput,
  bar: Bar,
  position: { stop: number | null; target: number | null; high: number },
): { trigger: "stop" | "trailing" | "target"; price: number } | null {
  const trail = strategy.exit.trailing
    ? position.high * (1 - strategy.exit.trailing)
    : null;
  const stop = Math.max(position.stop ?? 0, trail ?? 0);
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
export function prepareStrategy(
  raw: StrategyObjectInput,
  bars: readonly Bar[],
  external: StrategyExternalInputs = {},
) {
  const strategy = strategyObjectSchema.parse(raw);
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
  if (
    new Set(external.rps?.map((x) => x.date)).size !==
    (external.rps?.length ?? 0)
  )
    throw new Error("Duplicate RPS observations");
  const breakoutCache = new Map<number, ReturnType<typeof analyzeBreakout>>();
  const lowCache = new Map<string, ReturnType<typeof historicalLowSeries>>();
  const breakoutAt = (i: number) => {
    if (!breakoutCache.has(i)) {
      // Only one point is retained; historical playback must not retain O(n²) analyses.
      breakoutCache.clear();
      breakoutCache.set(i, analyzeBreakout(bars.slice(0, i + 1)));
    }
    return breakoutCache.get(i)!;
  };
  const compile = (rule: StrategyRule): ((index: number) => boolean | null) => {
    switch (rule.kind) {
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
        return (i) => {
          const facts = external.monitorCzsc;
          if (!facts) throw new Error("Missing native monitor observations");
          return (
            bars[i]!.volume > 0 &&
            selectCzscMonitorSignals(
              facts.observations,
              rule.config,
              bars[i]!.date,
              facts.seenKeys,
            ).fresh.length > 0
          );
        };
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
        const values = evaluateFormula(
          rule.source,
          bars,
          rule.parameters,
          external.rps,
        ).outputs[0]!.values;
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
        return (i) => {
          const result = breakoutAt(i).latest;
          const status =
            rule.side === "entry" ? result?.long.status : result?.short.status;
          return status === undefined || status === "未知"
            ? null
            : status === "是";
        };
      case "rps":
        return (i) => {
          const point = external.rps?.find((x) => x.date === bars[i]!.date);
          const value = point?.values[point.periods.indexOf(rule.period)]?.rps;
          return value == null ? null : value >= rule.minimum;
        };
      case "chan-third-buy":
        return (i) => {
          if (i < rule.firstIndex - 1) return null;
          if (i === rule.firstIndex - 1) return false;
          const observations = external.chan?.filter(
            (row) => row.date <= bars[i]!.date,
          );
          if (!observations)
            throw new Error("Missing serial native observations");
          return createNativeStudyRule(
            bars.slice(0, i + 1),
            rule.firstIndex,
            observations,
          )(i, { entry: 0, entryIndex: 0 }).enter;
        };
    }
  };
  const enter = compile(strategy.entry),
    leave = strategy.exit.rule ? compile(strategy.exit.rule) : () => false;
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
  return {
    strategy,
    breakoutAt,
    evaluate(index: number): StrategyDecision {
      if (!Number.isInteger(index) || index < 0 || index >= bars.length)
        throw new Error("Invalid strategy index");
      const exit = leave(index);
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
      return { entry: exit === false ? enter(index) : false, exit, stopLevel };
    },
  };
}
