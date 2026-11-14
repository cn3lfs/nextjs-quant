import { createHash } from "node:crypto";
import type { StrategyObjectInput } from "trading-strategies";
import type { ScreeningFormula } from "trading-strategies/formula/formula-screen";

export function formulaStrategy(
  formula: ScreeningFormula,
): StrategyObjectInput {
  return {
    id: `formula-${createHash("sha256")
      .update(JSON.stringify([formula.source, formula.parameters]))
      .digest("hex")
      .slice(0, 32)}`,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "all-market" },
    entry: {
      kind: "formula",
      source: formula.source,
      parameters: formula.parameters,
    },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
}
export function breakoutStrategy(
  symbols: string[],
  side: "entry" | "exit" = "entry",
): StrategyObjectInput {
  return {
    id: `dual-breakout-${side}`,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols },
    entry: { kind: "double-breakout", side },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
}
export function cryptoBotStrategy(
  config: { fast: number; slow: number; minutes: number; allocation: number },
  account: string,
): StrategyObjectInput {
  const period = new Map<number, StrategyObjectInput["period"]>([
    [5, "5m"],
    [15, "15m"],
    [30, "30m"],
    [60, "1h"],
    [240, "4h"],
    [1440, "day"],
  ]).get(config.minutes);
  if (!period) throw new Error("Unsupported bot period");
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        config.fast,
        config.slow,
        config.minutes,
        config.allocation,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  return {
    id: `crypto-dual-ma-${account}-${identity}`,
    version: 1,
    market: "crypto",
    period,
    universe: { kind: "symbols", symbols: ["BTCUSDT", "ETHUSDT"] },
    entry: {
      kind: "dual-ma",
      fast: config.fast,
      slow: config.slow,
      side: "entry",
    },
    exit: {
      rule: {
        kind: "dual-ma",
        fast: config.fast,
        slow: config.slow,
        side: "exit",
      },
    },
    sizing: { kind: "weight", weight: config.allocation },
    sleeve: "swing",
  };
}
