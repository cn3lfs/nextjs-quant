import { usesStrategyBook, type StrategyObjectInput } from "trading-strategies";
import { marketRules } from "trading-strategy-core/market-rules";
import type { ExecutionCosts } from "trading-strategy-core/costs";
import { sizePortfolioTargetEntry } from "quant-backtest";
import {
  evaluateStrategySeries,
  eligibleStrategySymbol,
  type StrategySeries,
} from "./evaluation";
import {
  bookEntry,
  evaluateDriverBook,
  type DriverBookContext,
  type DriverBookAdmission,
} from "./book";

export type ScanCapital = {
  equity: number;
  cash: number;
  riskPerTrade: number;
  step?: number;
  minimum?: number;
  maximum?: number;
  costs?: ExecutionCosts;
  existing?: { quantity: number; cost: number; stop: number | null };
};
/** Reference quantities exclude fees/slippage. Execution must obtain a fresh venue quote. */
export function scanStrategy(
  strategy: StrategyObjectInput,
  universe: readonly StrategySeries[],
  asOf: string,
  options: {
    membership?: readonly string[];
    capital?: ScanCapital;
    book?: DriverBookContext;
    admission?: DriverBookAdmission;
  } = {},
) {
  const admission = usesStrategyBook(strategy)
    ? (options.admission ??
      (options.book
        ? evaluateDriverBook(
            strategy,
            universe,
            asOf,
            options.book,
            options.membership,
          )
        : undefined))
    : undefined;
  const results = universe.flatMap((series) => {
    const allocation = usesStrategyBook(strategy)
      ? bookEntry(admission, strategy, asOf, series.symbol)
      : undefined;
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
      (!strategy.rebalance && result.decision.entry !== true) ||
      (usesStrategyBook(strategy) && !allocation)
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
      const baseWeight =
        sizing.kind === "equal"
          ? 1 / sizing.positions
          : sizing.kind === "weight"
            ? sizing.weight
            : 1;
      const weight = Math.min(baseWeight, allocation?.weight ?? 1);
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
        if (allocation) {
          if (!capital.costs)
            throw new Error("Missing frozen portfolio costs for book quantity");
          if ((allocation.currentWeight ?? 0) > 0 && !capital.existing)
            throw new Error(
              "Existing book holding quantity/cost required for target delta sizing",
            );
          quantity = sizePortfolioTargetEntry({
            sizing: result.strategy.rebalance
              ? { kind: "weight", weight: allocation.weight, tranches: 1 }
              : sizing,
            equity: capital.equity,
            cash: capital.cash,
            price: result.price,
            stop,
            riskPerTrade: capital.riskPerTrade,
            weightCeiling: allocation.weight,
            targetWeight: allocation.weight,
            existing: capital.existing,
            quantityRules: { step, minimum, maximum: capital.maximum ?? 1e12 },
            costs: capital.costs,
          }).quantity;
        }
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
        ...(admission
          ? {
              book: admission.decision,
              weightCeiling: allocation!.weight,
              rankScore: allocation!.score,
            }
          : {}),
      },
    ];
  });
  return admission
    ? results.sort(
        (a, b) =>
          (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
          a.symbol.localeCompare(b.symbol),
      )
    : results;
}
