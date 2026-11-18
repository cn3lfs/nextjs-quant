import type { PortfolioInstrument } from "quant-backtest";
import { rankRps } from "quant-rps";
import type { StrategyObjectInput } from "trading-strategies";
import type { FormulaRpsPoint } from "trading-strategies/formula/tdx-formula";

const periods = [20, 50, 120] as const;
export const relativeStrengthId = "pool-rps-weekly";

export function relativeStrengthStrategy(): StrategyObjectInput {
  return {
    id: relativeStrengthId,
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "rps", period: periods[0], minimum: 0 },
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "swing",
    rank: { kind: "rps-composite", periods: [...periods] },
    rebalance: {
      kind: "ranked-weekly",
      top: 10,
      retentionMultiple: 1,
      weighting: "equal",
    },
  };
}

function weekStart(date: string) {
  const day = new Date(date);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

/** Frozen-pool proxy using completed causal adjusted closes. The live
 * exchange-universe eligibility policy requires independent historical data. */
export function relativeStrengthInputs(
  instruments: readonly PortfolioInstrument[],
  calendar: readonly string[],
  start: string,
  end: string,
) {
  const stocks = instruments.map(({ symbol, signalBars }) => ({
    symbol,
    bars: new Map(signalBars.map((bar) => [bar.date, bar])),
    points: [] as FormulaRpsPoint[],
  }));
  let signalWeeks = 0;
  let minimumCoverage = stocks.length;

  for (let index = periods[2]; index + 1 < calendar.length; index++) {
    const date = calendar[index]!;
    if (
      date < start ||
      date >= end ||
      weekStart(date) === weekStart(calendar[index + 1]!)
    )
      continue;

    const rows = stocks.flatMap(({ symbol, bars, points }) => {
      const close = bars.get(date);
      if (!close || close.close <= 0 || close.volume <= 0) return [];
      const returns = periods.map((period) => {
        const earlier = bars.get(calendar[index - period]!);
        if (!earlier || earlier.close <= 0 || earlier.volume <= 0) return null;
        const value = close.close / earlier.close - 1;
        return Number.isFinite(value) ? value : null;
      });
      return returns.some((value) => value === null)
        ? []
        : [{ symbol, points, returns }];
    });
    minimumCoverage = Math.min(minimumCoverage, rows.length);
    if (rows.length < 2) continue;
    signalWeeks++;
    const ranks = periods.map((_, offset) =>
      rankRps(
        rows.map((row) => ({
          symbol: row.symbol,
          return: row.returns[offset]!,
        })),
      ),
    );
    for (const { symbol, points } of rows)
      points.push({
        date,
        periods,
        values: ranks.map((rank) => rank.get(symbol)!),
      });
  }

  return {
    instruments: instruments.map((instrument, index) => ({
      ...instrument,
      external: { ...instrument.external, rps: stocks[index]!.points },
    })),
    signalWeeks,
    minimumCoverage: signalWeeks ? minimumCoverage : 0,
  };
}
