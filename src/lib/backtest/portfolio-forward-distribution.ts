import type { PortfolioRequest, runPortfolio } from "quant-backtest";

type Result = ReturnType<typeof runPortfolio>;
/** Flat-to-flat cash returns, including fees and cash corporate actions. */
export function portfolioClosedTradeReturns(
  result: Pick<Result, "fills" | "corporateActions">,
) {
  const active = new Map<string, { cash: number; invested: number }>();
  const closed: {
    strategyId: string;
    symbol: string;
    date: string;
    return: number;
  }[] = [];
  const events = [
    ...result.corporateActions.map((action) => ({
      date: action.date,
      action,
      fill: null,
    })),
    ...result.fills.map((fill) => ({ date: fill.date, action: null, fill })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || (a.action ? -1 : 0) - (b.action ? -1 : 0),
  );
  for (const event of events) {
    const row = event.action ?? event.fill!;
    const key = JSON.stringify([row.strategyId, row.symbol]);
    let cycle = active.get(key);
    if (event.action) {
      if (cycle) cycle.cash += event.action.cash;
      continue;
    }
    const fill = event.fill!;
    if (!cycle) {
      if (fill.side !== "buy")
        throw new Error("A forward trade has no opening cash evidence");
      cycle = { cash: 0, invested: 0 };
      active.set(key, cycle);
    }
    const amount = fill.price * fill.quantity;
    if (fill.side === "buy") cycle.invested += amount + fill.fee;
    cycle.cash += (fill.side === "buy" ? -amount : amount) - fill.fee;
    if (fill.holdingAfter === 0) {
      if (!(cycle.invested > 0) || !Number.isFinite(cycle.cash))
        throw new Error("Invalid forward trade cash basis");
      closed.push({
        strategyId: fill.strategyId,
        symbol: fill.symbol,
        date: fill.date,
        return: cycle.cash / cycle.invested,
      });
      active.delete(key);
    }
  }
  return closed;
}

/** Model slippage is explicitly distinct from a venue fill. Protection fills
 * need the actual quote reference; their bar open is not an acceptable proxy. */
export function portfolioModelSlippage(
  result: Pick<Result, "fills" | "orders">,
  request: Pick<PortfolioRequest, "instruments">,
) {
  const samples: { strategyId: string; date: string; bps: number }[] = [];
  let missing = 0;
  for (const fill of result.fills) {
    const evidence = (
      fill as typeof fill & {
        executionEvidence?: {
          intendedPrice: number;
          slippageBps: number;
          source: string;
        };
      }
    ).executionEvidence;
    if (
      evidence &&
      evidence.intendedPrice > 0 &&
      Number.isFinite(evidence.intendedPrice) &&
      Number.isFinite(evidence.slippageBps)
    ) {
      samples.push({
        strategyId: fill.strategyId,
        date: fill.date,
        bps: evidence.slippageBps,
      });
      continue;
    }
    const order = result.orders.find((order) => order.id === fill.orderId);
    const bar = request.instruments
      .find((instrument) => instrument.symbol === fill.symbol)
      ?.bars.find((bar) => bar.date === fill.date);
    if (
      !bar ||
      !(bar.open > 0) ||
      (order?.trigger !== "signal" && order?.trigger !== "time")
    ) {
      missing++;
      continue;
    }
    samples.push({
      strategyId: fill.strategyId,
      date: fill.date,
      bps: (fill.price / bar.open - 1) * (fill.side === "buy" ? 1 : -1) * 10000,
    });
  }
  return { samples, missing, basis: "paper-model" as const };
}
