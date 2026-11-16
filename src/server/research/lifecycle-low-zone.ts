import type { PortfolioRequest } from "quant-backtest";
import {
  historicalLowSeries,
  marketLowZoneSeries,
  type MarketLowZoneInput,
  type MarketLowZoneConfig,
} from "trading-strategies";

/** One projection for research and prospective paper input. Unknown evidence
 * stays unknown; neither a stock nor the market can stand in for the other. */
export function projectLifecycleLowZone(
  instruments: PortfolioRequest["instruments"],
  input: MarketLowZoneInput,
  detector: MarketLowZoneConfig,
) {
  const market = marketLowZoneSeries(input, detector);
  const marketAt = new Map(market.map((point) => [point.date, point]));
  return {
    market,
    instruments: instruments.map((instrument) => {
      const facts = input.valuations
        .filter(
          (value) =>
            value.symbol === instrument.symbol &&
            Date.parse(value.availableAt) <=
              Date.parse(`${value.date}T15:00:00+08:00`),
        )
        .map((value) => ({
          date: value.date,
          availableAt: value.date,
          pe: value.pe,
          pb: value.pb,
          temperature: null,
          source: `${value.source}/${value.hash}; visible by completed CN close`,
          confidence: "verified" as const,
        }));
      const stock = historicalLowSeries(
        instrument.signalBars,
        {
          years: detector.years,
          minimumBars: detector.minimumBars,
          recoveryPercentile: detector.recoveryPercentile,
        },
        facts,
      );
      const signals = stock.map((point, index) => {
        const observed = marketAt.get(point.date);
        const ownEntry =
          point.depth === null
            ? null
            : point.depth > 0 && point.depth > (stock[index - 1]?.depth ?? 0);
        return {
          id: "l3-market-low-zone",
          date: point.date,
          availableAt: point.date,
          entry:
            ownEntry === false || observed?.entry === false
              ? false
              : ownEntry === true && observed?.entry === true
                ? true
                : null,
          exit:
            point.recovery === true || observed?.exit === true
              ? true
              : point.recovery === false && observed?.exit === false
                ? false
                : null,
        };
      });
      return {
        ...instrument,
        external: { ...instrument.external, signals },
      };
    }),
  };
}
