import { rpsHash } from "~/server/infra/content-hash";
import type { Bar } from "~/lib/domain";
import { calculateRps, rpsPeriods, type RpsSecurity } from "quant-rps";
import { adjustmentFactors } from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";

/** Reuse the causal GBBQ factors; unsupported categories must not silently become raw prices. */
export function prepareRpsSecurity(
  symbol: string,
  name: string,
  bars: Bar[],
  events: TdxXdxr[],
  keepFrom: string,
): RpsSecurity {
  const factors = adjustmentFactors(bars, events);
  const unsupportedDates = events
    .filter(
      (e) =>
        e.category === 11 ||
        e.category === 12 ||
        (e.category === 1 &&
          [e.dividend, e.rightsPrice, e.bonusRatio, e.rightsRatio].some(
            (v) => v !== undefined && (!Number.isFinite(v) || v < 0),
          )),
    )
    .map((e) => e.date);
  // The shared factor helper skips non-positive theoretical ex-prices; flag these instead.
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1]!;
    let base = previous.close;
    for (const event of events.filter(
      (e) =>
        e.category === 1 && e.date > previous.date && e.date <= bars[i]!.date,
    )) {
      base =
        (base -
          (event.dividend ?? 0) +
          (event.rightsRatio ?? 0) * (event.rightsPrice ?? 0)) /
        (1 + (event.rightsRatio ?? 0) + (event.bonusRatio ?? 0));
      if (!(base > 0) || !Number.isFinite(base))
        unsupportedDates.push(event.date);
    }
  }
  return {
    symbol,
    name,
    firstDate: bars[0]?.date ?? "9999-12-31",
    unsupportedDates,
    closes: new Map(
      bars.flatMap((bar, i) =>
        bar.date < keepFrom
          ? []
          : [
              [
                bar.date,
                { close: bar.close * factors[i]!.factor, volume: bar.volume },
              ] as const,
            ],
      ),
    ),
  };
}

/** Adapt pure calculation inputs to the application's immutable evidence hash. */
export function calculateRpsDay(
  stocks: RpsSecurity[],
  calendar: string[],
  date: string,
  periods: readonly number[] = rpsPeriods,
) {
  const { inputs, ...result } = calculateRps(stocks, calendar, date, periods);
  return { ...result, inputHash: rpsHash(inputs) };
}
