import {
  pairPositionCycles,
  evaluateTrades,
  type TradeFill,
} from "quant-performance";
import type { Csi800Stock } from "../../packages/quant-backtest/src/csi800-study.js";

/** Independent of the optional stop-loss ledger; also covers the no-overlay baseline. */
export function csi800TradeEvaluation(
  fills: readonly TradeFill[],
  stocks: readonly Csi800Stock[],
) {
  const actions = stocks.flatMap((s) =>
    s.actions
      .filter((a) => a.date <= (fills.at(-1)?.date ?? ""))
      .map((a) => ({ ...a, symbol: s.symbol })),
  );
  const cycles = pairPositionCycles(fills, actions);
  return { cycles, evaluation: evaluateTrades(cycles) };
}
