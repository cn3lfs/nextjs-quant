import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import { calculateFactor } from "trading-strategy-core/factors";
import { researchJsonHash } from "../../../src/server/research/research-run";

export const lowVolatilityId = "rank-low-volatility";
const period = 60;

export function lowVolatilityTargets(
  instruments: readonly PortfolioInstrument[],
  calendar: readonly string[],
  start: string,
  end: string,
): NonNullable<PortfolioRequest["scheduledTargets"]> {
  const stocks = instruments.map(({ symbol, signalBars }) => ({
    symbol,
    bars: new Map(signalBars.map((bar) => [bar.date, bar])),
  }));
  return calendar.flatMap((date, index) => {
    const next = calendar[index + 1];
    if (
      index < period ||
      date < start ||
      date >= end ||
      !next ||
      date.slice(0, 7) === next.slice(0, 7)
    )
      return [];
    const dates = calendar.slice(index - period, index + 1);
    const ranked = stocks
      .flatMap(({ symbol, bars }) => {
        const window = dates
          .map((day) => bars.get(day))
          .filter(
            (bar): bar is NonNullable<typeof bar> =>
              bar !== undefined && bar.close > 0 && bar.volume > 0,
          );
        if (window.length !== period + 1) return [];
        const volatility = calculateFactor(window, {
          id: "return-volatility",
          parameters: { period },
        }).values.at(-1);
        return volatility && volatility > 0 ? [{ symbol, volatility }] : [];
      })
      .sort(
        (a, b) =>
          a.volatility - b.volatility || a.symbol.localeCompare(b.symbol),
      );
    if (!ranked.length) return [];
    const selected = ranked.slice(0, 10);
    return [
      {
        strategyId: lowVolatilityId,
        date,
        availableAt: date,
        sourceHash: researchJsonHash({ date, ranked }),
        targets: Object.fromEntries(
          selected.map(({ symbol }) => [symbol, 0.1]),
        ),
        scores: Object.fromEntries(
          selected.map(({ symbol, volatility }) => [symbol, -volatility]),
        ),
      },
    ];
  });
}
