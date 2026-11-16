import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import { paperStrategy } from "../strategies/drivers/paper";
import { evaluateStrategySeries } from "../strategies/drivers/evaluation";
import { usesStrategyBook } from "trading-strategies";
import type { PaperState } from "./model";
/** Record each first-observed raw rule before portfolio admission. Legacy
 * replay may discard warmup; native book/exit replay retains its full context. */
export function capturePaperDecisions(
  strategies: PortfolioRequest["strategies"],
  instrument: PortfolioInstrument,
  dates: readonly string[],
  observedAt: number,
  source: string,
  memberships?: PortfolioRequest["memberships"],
) {
  const captured: PaperState["decisions"] = [];
  for (const date of dates) {
    if (!instrument.bars.some((b) => b.date === date)) continue;
    for (const strategy of strategies) {
      const series = {
        symbol: instrument.symbol,
        market: instrument.market,
        bars: instrument.signalBars,
        rawBars: instrument.bars,
        external: instrument.external,
      };
      const result = evaluateStrategySeries(strategy, series, date);
      if (!result) continue;
      // Capture the raw completed rule, before cross-sectional admission. A
      // single instrument cannot reconstruct a portfolio book decision.
      if (
        !usesStrategyBook(strategy) &&
        !strategy.exit.chandelier &&
        !strategy.exit.timeReentry
      )
        paperStrategy(strategy, series, date, {
          membership: memberships?.find(
            (m) => m.strategyId === strategy.id && m.date === date,
          )?.symbols,
        });
      captured.push({
        strategyId: strategy.id,
        symbol: instrument.symbol,
        date,
        entry: result.decision.entry,
        exit: result.decision.exit,
        stop: result.decision.stopLevel,
        observedAt,
        source,
      });
    }
  }
  return captured;
}
