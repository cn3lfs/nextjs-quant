import { z } from "zod";
import {
  calculateFactor,
  resolveFactor,
  factorConditionSchema,
  type FactorSpec,
} from "trading-strategy-core/factors";
import type { Bar } from "trading-strategy-core/bars";
export type SignalSeries = {
  id: string;
  warmupBars: number;
  values: Int8Array;
};

export const factorStrategyId = "factor-combination-v1" as const;
const groupSchema = z
  .object({
    mode: z.enum(["all", "any"]),
    conditions: z.array(factorConditionSchema).min(1).max(12),
  })
  .strict();
export const factorStrategySchema = z
  .object({
    id: z.literal(factorStrategyId),
    version: z.literal(1),
    name: z.string().trim().min(1).max(60),
    entry: groupSchema,
    exit: groupSchema,
  })
  .strict();
export type FactorStrategy = z.infer<typeof factorStrategySchema>;
export type FactorCondition = z.infer<typeof factorConditionSchema>;
export type FactorStrategyInput = z.input<typeof factorStrategySchema>;

export function factorStrategyWarmup(raw: FactorStrategyInput) {
  const strategy = factorStrategySchema.parse(raw);
  return Math.max(
    1,
    ...[...strategy.entry.conditions, ...strategy.exit.conditions].map(
      (condition) => {
        const left = resolveFactor(condition.left).lookbackBars;
        const right =
          "factor" in condition.right
            ? resolveFactor(condition.right.factor).lookbackBars
            : 0;
        return (
          Math.max(left, right) +
          (condition.operator.startsWith("cross-") ? 1 : 0)
        );
      },
    ),
  );
}

/** A condition uses only the current completed bar and optionally its predecessor.
 * Missing evidence is unknown: any/all propagate it, and unknown never trades.
 */
export function factorStrategySignals(
  bars: readonly Bar[],
  raw: FactorStrategyInput,
): SignalSeries {
  const strategy = factorStrategySchema.parse(raw);
  const cache = new Map<string, (number | null)[]>();
  function series(spec: FactorSpec) {
    const resolved = resolveFactor(spec).spec;
    const key = JSON.stringify(resolved);
    if (!cache.has(key)) cache.set(key, calculateFactor(bars, resolved).values);
    return cache.get(key)!;
  }
  function compile(condition: FactorCondition) {
    const left = series(condition.left);
    const operand = condition.right;
    const right =
      "factor" in operand
        ? series(operand.factor)
        : bars.map(() => operand.constant);
    return (i: number): boolean | null => {
      const a = left[i],
        b = right[i];
      if (a == null || b == null) return null;
      switch (condition.operator) {
        case "gt":
          return a > b;
        case "gte":
          return a >= b;
        case "lt":
          return a < b;
        case "lte":
          return a <= b;
        case "cross-above":
        case "cross-below": {
          const previousA = left[i - 1],
            previousB = right[i - 1];
          if (previousA == null || previousB == null) return null;
          return condition.operator === "cross-above"
            ? previousA <= previousB && a > b
            : previousA >= previousB && a < b;
        }
      }
    };
  }
  function compileGroup(group: FactorStrategy["entry"]) {
    const conditions = group.conditions.map(compile);
    return (i: number): boolean | null => {
      const results = conditions.map((evaluate) => evaluate(i));
      if (group.mode === "all") {
        if (results.includes(false)) return false;
        return results.includes(null) ? null : true;
      }
      if (results.includes(true)) return true;
      return results.includes(null) ? null : false;
    };
  }
  const enter = compileGroup(strategy.entry),
    exit = compileGroup(strategy.exit);
  const warmupBars = factorStrategyWarmup(strategy);
  const values = new Int8Array(bars.length);
  for (let i = warmupBars; i < bars.length; i++) {
    const exitMatched = exit(i);
    if (exitMatched === true) values[i] = -1;
    else if (exitMatched === false && enter(i) === true) values[i] = 1;
  }
  return { id: factorStrategyId, warmupBars, values };
}

export const factorStrategyPresets: FactorStrategyInput[] = [
  {
    id: factorStrategyId,
    version: 1,
    name: "双均线交叉",
    entry: {
      mode: "all",
      conditions: [
        {
          left: { id: "sma", parameters: { period: 5 } },
          operator: "cross-above",
          right: { factor: { id: "sma", parameters: { period: 20 } } },
        },
      ],
    },
    exit: {
      mode: "any",
      conditions: [
        {
          left: { id: "sma", parameters: { period: 5 } },
          operator: "cross-below",
          right: { factor: { id: "sma", parameters: { period: 20 } } },
        },
      ],
    },
  },
  {
    id: factorStrategyId,
    version: 1,
    name: "放量通道突破",
    entry: {
      mode: "all",
      conditions: [
        {
          left: { id: "close" },
          operator: "gt",
          right: { factor: { id: "prior-high", parameters: { period: 20 } } },
        },
        {
          left: { id: "volume-ratio", parameters: { period: 5 } },
          operator: "gte",
          right: { constant: 1.5 },
        },
      ],
    },
    exit: {
      mode: "any",
      conditions: [
        {
          left: { id: "close" },
          operator: "lt",
          right: { factor: { id: "prior-low", parameters: { period: 10 } } },
        },
      ],
    },
  },
  {
    id: factorStrategyId,
    version: 1,
    name: "RSI 回升",
    entry: {
      mode: "all",
      conditions: [
        {
          left: { id: "rsi" },
          operator: "cross-above",
          right: { constant: 30 },
        },
      ],
    },
    exit: {
      mode: "any",
      conditions: [
        {
          left: { id: "rsi" },
          operator: "cross-below",
          right: { constant: 70 },
        },
      ],
    },
  },
];
