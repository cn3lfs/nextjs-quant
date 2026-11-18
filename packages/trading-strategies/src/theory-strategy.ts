import { theoryDefinitions } from "./theory-catalog.js";
import type { TripleScreenVariant } from "./theory-multiperiod.js";
import { utcOrbDefinition, utcOrbSymbols } from "./theory-orb.js";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "./strategy-object.js";

export { utcOrbDefinition, utcOrbSymbols } from "./theory-orb.js";
/** Research configuration only. Does not register, enable, notify, or trade. */
export function theoryStrategy(
  strategyId: string,
  market: StrategyObjectInput["market"],
  symbols: string[],
) {
  const definition = theoryDefinitions.find((row) => row.id === strategyId);
  if (!definition) throw new Error("Unknown executable theory strategy");
  return strategyObjectSchema.parse({
    id: `${strategyId}-${market}`,
    version: 1,
    market,
    period: "day",
    universe: { kind: "symbols", symbols },
    entry: { kind: "study-rule", strategy: definition.id, side: "entry" },
    exit: {
      rule: { kind: "study-rule", strategy: definition.id, side: "exit" },
    },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  });
}

/** F04.05 runnable research preset. BTC/ETH spot 5m only; no CN T+1 variant.
 * Constructing one has no account, notification or mode effects. */
export function utcOrbStrategy(
  symbols: readonly string[] = [...utcOrbSymbols],
) {
  return strategyObjectSchema.parse({
    id: "theory-utc-orb-crypto",
    version: 1,
    market: "crypto",
    period: "5m",
    universe: { kind: "symbols", symbols: [...symbols] },
    entry: { kind: "utc-orb", side: "entry" },
    exit: { rule: { kind: "utc-orb", side: "exit" } },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "breakout",
  });
}

/** Explicit research presets; constructing one has no account or mode effects. */
export function tripleScreenStrategy(
  variant: TripleScreenVariant,
  market: StrategyObjectInput["market"],
  symbols: string[],
) {
  return strategyObjectSchema.parse({
    id: `theory-triple-screen-${variant}-${market}`,
    version: 1,
    market,
    period: variant === "week-day" ? "day" : "5m",
    universe: { kind: "symbols", symbols },
    entry: { kind: "triple-screen", variant, side: "entry" },
    exit: { rule: { kind: "triple-screen", variant, side: "exit" } },
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
  });
}
