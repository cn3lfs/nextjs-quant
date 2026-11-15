import type { StrategyObjectInput } from "trading-strategies";
import { watchStrategy } from "./watch";
import type { StrategySeries } from "./evaluation";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";

/** Local paper accounting uses the exact backtest execution and account rules. */
export function runPaperPortfolio(request: PortfolioRequest) {
  return runPortfolio(request);
}
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
