import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import { paperStrategy } from "../strategies/drivers/paper";
import { evaluateStrategySeries } from "../strategies/drivers/evaluation";
import type { PaperState } from "./model";
/** Capture before discarding indicator warmup. A full source series is held for
 * one instrument at a time; the durable replay needs only forward raw bars. */
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
