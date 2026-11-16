import type { PortfolioFill } from "quant-backtest";

/** Order counters, signal provenance and model reference quotes are not new
 * economic trades. Preserve actual fill order, fees and resulting cash/shares. */
export function economicFillList(
  fills: readonly PortfolioFill[],
  canonicalStrategyId?: string,
) {
  return fills.map((fill) => {
    if (
      ![
        fill.price,
        fill.quantity,
        fill.fee,
        fill.cashAfter,
        fill.holdingAfter,
      ].every(Number.isFinite)
    )
      throw new Error("Nonfinite economic fill evidence");
    return {
      strategyId:
        canonicalStrategyId ??
        fill.strategyId.replace(/-neighbor-(?:entry-)?\d+$/, ""),
      sleeve: fill.sleeve,
      symbol: fill.symbol,
      side: fill.side,
      date: fill.date,
      price: fill.price,
      quantity: fill.quantity,
      fee: fill.fee,
      cashAfter: fill.cashAfter,
      holdingAfter: fill.holdingAfter,
    };
  });
}
