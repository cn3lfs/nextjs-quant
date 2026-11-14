import {
  strategyProtection,
  type StrategyObjectInput,
} from "trading-strategies";
import {
  evaluateStrategySeries,
  eligibleStrategySymbol,
  type StrategySeries,
} from "./evaluation";

export type WatchPosition = {
  quantity: number;
  stop: number | null;
  target: number | null;
  high: number;
  bars: number;
  tranches: number;
};
export type WatchEvent = {
  key: string;
  strategyId: string;
  version: number;
  market: "cn-equity" | "crypto";
  symbol: string;
  bar: string;
  type: "entry" | "exit" | "stop" | "target";
  price: number;
  sleeve: string;
  stop: number | null;
  target: number | null;
};
/** Pure completed-bar driver. Persistence/dedupe is a separate atomic boundary.
 * Existing protection wins over targets; today's high never raises today's stop.
 */
export function watchStrategy(
  strategy: StrategyObjectInput,
  series: StrategySeries,
  asOf: string,
  options: { position?: WatchPosition; membership?: readonly string[] } = {},
): WatchEvent[] {
  const result = evaluateStrategySeries(strategy, series, asOf);
  if (!result || result.bar !== asOf) return [];
  const holding = options.position;
  if (
    holding &&
    (!Number.isFinite(holding.quantity) ||
      holding.quantity < 0 ||
      !Number.isFinite(holding.high) ||
      holding.high <= 0 ||
      !Number.isInteger(holding.bars) ||
      holding.bars < 0 ||
      !Number.isInteger(holding.tranches) ||
      holding.tranches < 0 ||
      [holding.stop, holding.target].some(
        (v) => v !== null && (!Number.isFinite(v) || v <= 0),
      ))
  )
    throw new Error("Invalid watch position");
  const position = holding && holding.quantity > 0 ? holding : undefined;
  const raw = (series.rawBars ?? series.bars).find((b) => b.date === asOf)!;
  let type: WatchEvent["type"] | null = null;
  let price = result.price;
  const protection =
    position && position.quantity > 0
      ? strategyProtection(result.strategy, raw, position)
      : null;
  if (protection) {
    type = protection.trigger === "target" ? "target" : "stop";
    price = protection.price;
  } else if (
    result.decision.exit === true ||
    (position &&
      result.strategy.exit.maxBars !== undefined &&
      position.bars + 1 >= result.strategy.exit.maxBars)
  )
    type = "exit";
  else if (
    result.decision.entry === true &&
    (!position || position.tranches < result.strategy.sizing.tranches) &&
    eligibleStrategySymbol(strategy, series, asOf, options.membership)
  )
    type = "entry";
  if (!type) return [];
  return [
    {
      key: JSON.stringify([
        strategy.id,
        strategy.version,
        strategy.market,
        series.symbol,
        asOf,
      ]),
      strategyId: strategy.id,
      version: strategy.version,
      market: strategy.market,
      symbol: series.symbol,
      bar: asOf,
      type,
      price,
      sleeve: strategy.sleeve,
      stop: result.decision.stopLevel,
      target: result.strategy.exit.takeProfit
        ? result.price * (1 + result.strategy.exit.takeProfit)
        : null,
    },
  ];
}
