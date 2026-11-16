import {
  prepareStrategy,
  usesStrategyBook,
  type StrategyObjectInput,
  type StrategyExternalInputs,
} from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";

export type StrategySeries = {
  symbol: string;
  market: "cn-equity" | "crypto";
  bars: readonly Bar[];
  rawBars?: readonly Bar[];
  external?: StrategyExternalInputs;
};
export type StrategyEvaluation = ReturnType<typeof evaluateStrategySeries>;

/** The input contains completed bars only, at a frozen adjustment denominator.
 * Cut the prefix before compilation so a driver never uses a future observation.
 */
export function evaluateStrategySeries(
  strategy: StrategyObjectInput,
  series: StrategySeries,
  asOf: string,
) {
  if (!Number.isFinite(Date.parse(asOf))) throw new Error("Invalid as-of");
  if (series.market !== strategy.market)
    throw new Error("Strategy market mismatch");
  const bars =
    series.bars.length && series.bars.at(-1)!.date <= asOf
      ? series.bars
      : series.bars.filter((b) => b.date <= asOf);
  if (!bars.length) return null;
  const prepared = prepareStrategy(strategy, bars, series.external);
  const bar = bars.at(-1)!;
  const raw =
    series.rawBars?.find((b) => b.date === bar.date) ??
    (series.rawBars ? undefined : bar);
  if (!raw) throw new Error("Missing aligned raw bar");
  const decision = prepared.evaluate(bars.length - 1);
  const ratio = raw.close / bar.close;
  return {
    strategy: prepared.strategy,
    symbol: series.symbol,
    bar: bar.date,
    price: raw.close,
    evidence: prepared.explain(bars.length - 1),
    ...(usesStrategyBook(strategy) ? { signalDecision: decision } : {}),
    decision: {
      ...decision,
      stopLevel:
        decision.stopLevel === null ? null : decision.stopLevel * ratio,
      ...(strategy.exit.chandelier
        ? {
            chandelierStop:
              decision.chandelierStop == null
                ? null
                : decision.chandelierStop * ratio,
          }
        : {}),
    },
  };
}

export function eligibleStrategySymbol(
  strategy: StrategyObjectInput,
  series: StrategySeries,
  asOf: string,
  membership?: readonly string[],
) {
  // Coverage starts at the first observed source record, not a certified IPO.
  if (
    usesStrategyBook(strategy) &&
    (!series.bars.length || series.bars[0]!.date > asOf)
  )
    return false;
  if (strategy.universe.kind === "symbols")
    return strategy.universe.symbols.includes(series.symbol);
  if (strategy.universe.kind === "rps") {
    const point = series.external?.rps?.find((p) => p.date === asOf);
    const value =
      point?.values[point.periods.indexOf(strategy.universe.period)]?.rps;
    return value != null && value >= strategy.universe.minimum;
  }
  if (!membership) throw new Error("Missing PIT universe membership");
  return membership.includes(series.symbol);
}
