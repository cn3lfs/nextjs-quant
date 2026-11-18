import {
  prepareStrategy,
  type StrategyRuleEvidence,
  type TripleScreenPosition,
} from "trading-strategies";
import type { PortfolioRequest, runPortfolio } from "quant-backtest";

/** Actual fills establish positions. Unknown/no-candidate closes remain visible
 * even when the strategy generates no orders at all. */
export function labBacktestEvidence(
  request: PortfolioRequest,
  result: ReturnType<typeof runPortfolio>,
) {
  const signals: {
    orderId: number;
    symbol: string;
    strategyId: string;
    signalAt: string;
    evidence: StrategyRuleEvidence;
  }[] = [];
  const diagnostics: {
    symbol: string;
    strategyId: string;
    evaluated: number;
    unknown: number;
    reasons: Record<string, number>;
  }[] = [];
  for (const strategy of request.strategies) {
    if (
      strategy.entry.kind !== "triple-screen" &&
      strategy.entry.kind !== "utc-orb"
    )
      continue;
    for (const instrument of request.instruments) {
      const compiled = prepareStrategy(
        strategy,
        instrument.signalBars,
        instrument.external,
      );
      const indices = new Map(
        instrument.bars.map((bar, index) => [bar.date, index]),
      );
      const fills = result.fills.filter(
        (fill) =>
          fill.strategyId === strategy.id && fill.symbol === instrument.symbol,
      );
      const orders = new Map<string, typeof result.orders>();
      for (const order of result.orders) {
        if (
          order.strategyId !== strategy.id ||
          order.symbol !== instrument.symbol
        )
          continue;
        const group = orders.get(order.signalAt) ?? [];
        group.push(order);
        orders.set(order.signalAt, group);
      }
      let cursor = 0,
        lastExitIndex: number | undefined;
      let position: TripleScreenPosition | undefined;
      const summary = {
        symbol: instrument.symbol,
        strategyId: strategy.id,
        evaluated: 0,
        unknown: 0,
        reasons: {} as Record<string, number>,
      };
      for (let index = 0; index < instrument.bars.length; index++) {
        const date = instrument.bars[index]!.date;
        if (date < request.start || date > request.end) continue;
        while (cursor < fills.length && fills[cursor]!.date <= date) {
          const fill = fills[cursor++]!;
          if (fill.holdingAfter === 0) {
            lastExitIndex = indices.get(fill.date)!;
            position = undefined;
          } else if (fill.side === "buy" && !position) {
            const entryIndex = indices.get(fill.date)!;
            position = {
              entry:
                (fill.price * instrument.signalBars[entryIndex]!.close) /
                instrument.bars[entryIndex]!.close,
              entryIndex,
              signalIndex: indices.get(fill.signalAt)!,
              lastExitIndex,
            };
          }
        }
        const state = position ?? {
          entry: 0,
          entryIndex: index,
          lastExitIndex,
        };
        const decision = compiled.evaluate(index, state);
        const evidence = compiled.explain(index, state);
        const reason =
          typeof evidence.inputs.reason === "string"
            ? evidence.inputs.reason
            : "unspecified";
        summary.evaluated++;
        summary.unknown += Number(
          decision.entry === null || decision.exit === null,
        );
        summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
        for (const order of orders.get(date) ?? [])
          signals.push({
            orderId: order.id,
            symbol: instrument.symbol,
            strategyId: strategy.id,
            signalAt: date,
            evidence,
          });
      }
      diagnostics.push(summary);
    }
  }
  return { signals, diagnostics };
}
