import { z } from "zod";
import { periods, type Bar } from "trading-strategy-core/bars";
import { calculateFactor } from "trading-strategy-core/factors";
import {
  factorStrategySchema,
  factorStrategySignals,
} from "./factor-strategy.js";
import { cryptoDualMa } from "./crypto-dual-ma.js";
import { analyzeBreakout } from "./research/breakout/breakout.js";
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
export const strategyRuleSchema = z.discriminatedUnion("kind", [
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
      kind: z.literal("external"),
      id: z.string().min(1),
      side: z.enum(["entry", "exit"]),
    })
    .strict(),
]);
export const strategyObjectSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.literal(1),
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
export type StrategyDecision = {
  entry: boolean | null;
  exit: boolean | null;
  stopLevel: number | null;
};

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
      !Number.isFinite(Date.parse(b.date)) ||
      ![b.open, b.high, b.low, b.close].every(
        (v) => Number.isFinite(v) && v > 0,
      ) ||
      ![b.volume, b.amount].every((v) => Number.isFinite(v) && v >= 0) ||
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
  const compile = (rule: StrategyRule): ((index: number) => boolean | null) => {
    switch (rule.kind) {
      case "constant":
        return () => rule.value;
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
          const result = analyzeBreakout(bars.slice(0, i + 1)).latest;
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
  const atr =
    stop?.kind === "atr"
      ? calculateFactor(bars, {
          id: "atr",
          parameters: { period: stop.period },
        }).values
      : undefined;
  return {
    strategy,
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
        const levels =
          external.levels?.filter(
            (x) => x.field === stop.field && x.date === bars[index]!.date,
          ) ?? [];
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
