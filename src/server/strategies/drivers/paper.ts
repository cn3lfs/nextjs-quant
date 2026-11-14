import type { StrategyObjectInput } from "trading-strategies";
import { watchStrategy } from "./watch";
import type { StrategySeries } from "./evaluation";
/** Intent only: the account owner must persist admission before any adapter write. */
export function paperStrategy(
  strategy: StrategyObjectInput,
  series: StrategySeries,
  asOf: string,
  options: Parameters<typeof watchStrategy>[3] = {},
) {
  return watchStrategy(strategy, series, asOf, options).map((event) => ({
    ...event,
    side: event.type === "entry" ? ("BUY" as const) : ("SELL" as const),
  }));
}
