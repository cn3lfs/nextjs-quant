import type { StrategyObjectInput } from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  evaluateStrategySeries,
  eligibleStrategySymbol,
  type StrategySeries,
} from "./evaluation";

export type ScanCapital = {
  equity: number;
  cash: number;
  riskPerTrade: number;
  step?: number;
  minimum?: number;
};
/** Reference quantities exclude fees/slippage. Execution must obtain a fresh venue quote. */
export function scanStrategy(
  strategy: StrategyObjectInput,
  universe: readonly StrategySeries[],
  asOf: string,
  options: { membership?: readonly string[]; capital?: ScanCapital } = {},
) {
  return universe.flatMap((series) => {
    const result = evaluateStrategySeries(strategy, series, asOf);
    if (
      !result ||
      (asOf.length === 10 && result.bar !== asOf) ||
      !eligibleStrategySymbol(
        strategy,
        series,
        result.bar,
        options.membership,
      ) ||
      result.decision.entry !== true
    )
      return [];
    const { sizing } = result.strategy;
    const stop = result.decision.stopLevel;
    const target = result.strategy.exit.takeProfit
      ? result.price * (1 + result.strategy.exit.takeProfit)
      : null;
    const capital = options.capital;
    let quantity: number | null = null;
    if (capital) {
      if (
        ![capital.equity, capital.cash, capital.riskPerTrade].every(
          (v) => Number.isFinite(v) && v >= 0,
        ) ||
        capital.riskPerTrade > 1
      )
        throw new Error("Invalid scan capital");
      const weight =
        sizing.kind === "equal"
          ? 1 / sizing.positions
          : sizing.kind === "weight"
            ? sizing.weight
            : 1;
      let size =
        Math.min(capital.cash, (capital.equity * weight) / sizing.tranches) /
        result.price;
      if (stop !== null && stop > 0 && stop < result.price)
        size = Math.min(
          size,
          (capital.equity *
            Math.min(
              capital.riskPerTrade,
              sizing.kind === "risk" ? sizing.fraction : capital.riskPerTrade,
            )) /
            (result.price - stop),
        );
      else if (result.strategy.exit.stop) size = 0;
      const step = capital.step ?? marketRules[strategy.market].quantity.step;
      const minimum =
        capital.minimum ?? marketRules[strategy.market].quantity.minimum;
      if (step != null && minimum != null) {
        if (step <= 0 || minimum <= 0 || !Number.isFinite(step + minimum))
          throw new Error("Invalid scan quantity rules");
        quantity = Math.floor(size / step) * step;
        if (quantity < minimum) quantity = 0;
      }
    }
    return [
      {
        ...result,
        sleeve: result.strategy.sleeve,
        stop,
        target,
        quantity,
        tranches: sizing.tranches,
      },
    ];
  });
}
