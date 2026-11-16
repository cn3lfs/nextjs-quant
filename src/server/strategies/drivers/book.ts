import {
  evaluateStrategyBook,
  strategyObjectSchema,
  strategyReentryAllowed,
  type StrategyObjectInput,
  type StrategyBookState,
  type StrategyBookFacts,
  type StrategyBookDecision,
  type StrategyReentryState,
} from "trading-strategies";
import {
  eligibleStrategySymbol,
  evaluateStrategySeries,
  type StrategySeries,
} from "./evaluation";

export type DriverBookContext = {
  calendar: readonly string[];
  equity: number;
  initial: number;
  maxPositions: number;
  state?: StrategyBookState;
  facts?: StrategyBookFacts;
  holdings: readonly {
    symbol: string;
    weight: number;
    openRisk: number | null;
    managed?: boolean;
  }[];
  reentries: Record<string, StrategyReentryState>;
};
export type DriverBookAdmission = {
  strategyId: string;
  version: number;
  decision: StrategyBookDecision;
};

/** The caller supplies a complete causal universe and actual portfolio state. No IO. */
export function evaluateDriverBook(
  strategy: StrategyObjectInput,
  universe: readonly StrategySeries[],
  asOf: string,
  context: DriverBookContext,
  membership?: readonly string[],
): DriverBookAdmission {
  const parsed = strategyObjectSchema.parse(strategy);
  const candidates = universe.map((series) => {
    const result = evaluateStrategySeries(parsed, series, asOf);
    const decision =
      result?.bar === asOf
        ? (result.signalDecision ?? result.decision)
        : { entry: null, exit: null, stopLevel: null };
    const allowed = strategyReentryAllowed(
      parsed.exit,
      context.reentries[series.symbol],
      context.calendar.indexOf(asOf),
      decision.entry,
    );
    return {
      symbol: series.symbol,
      bars: series.bars,
      external: series.external,
      decision: allowed ? decision : { ...decision, entry: false },
      eligible: eligibleStrategySymbol(parsed, series, asOf, membership),
    };
  });
  return {
    strategyId: parsed.id,
    version: parsed.version,
    decision: evaluateStrategyBook(parsed, {
      date: asOf,
      candidates,
      ...context,
    }),
  };
}

export function bookEntry(
  admission: DriverBookAdmission | undefined,
  strategy: StrategyObjectInput,
  asOf: string,
  symbol: string,
) {
  validateBookAdmission(admission, strategy, asOf);
  return admission!.decision.available
    ? admission!.decision.entries.find(
        (e) => e.symbol === symbol && e.weight > 0,
      )
    : undefined;
}
export function validateBookAdmission(
  admission: DriverBookAdmission | undefined,
  strategy: StrategyObjectInput,
  asOf: string,
) {
  if (
    !admission ||
    admission.strategyId !== strategy.id ||
    admission.version !== strategy.version ||
    admission.decision.date !== asOf
  )
    throw new Error("Missing same-version, same-bar strategy book context");
}
