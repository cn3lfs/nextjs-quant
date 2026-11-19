import { csi800SignalBars, type Csi800Stock } from "trading-strategies";
import { rankRps } from "quant-rps";
import type { FormulaRpsPoint } from "trading-strategies/formula/tdx-formula";

import { lifecycleRpsPeriods } from "./source-types";
import {
  sourceCacheBudget,
  bytesHash,
  contentHash,
  memoryBoundary,
  orderedBars,
} from "./source-artifacts";

type RpsView = {
  periods: readonly number[];
  ranks: Float32Array;
  closes: Float64Array;
  counts: Uint16Array;
  dates: number;
  width: number;
  longest: number;
};
/** One shared accessor instead of a closure for each symbol/date. */
class LifecycleRpsPoint implements FormulaRpsPoint {
  readonly periods: readonly number[];
  #view: RpsView;
  #symbol: number;
  #day: number;
  constructor(
    readonly date: string,
    view: RpsView,
    symbol: number,
    day: number,
  ) {
    this.periods = view.periods;
    this.#view = view;
    this.#symbol = symbol;
    this.#day = day;
    Object.defineProperty(this, "values", {
      enumerable: true,
      get: lifecycleRpsValuesGetter,
    });
  }
  get values(): FormulaRpsPoint["values"] {
    const v = this.#view,
      s = this.#symbol,
      d = this.#day;
    return v.periods.map((period, p) => {
      const rank = v.ranks[(s * v.dates + d) * v.periods.length + p]!;
      return Number.isNaN(rank)
        ? null
        : {
            return:
              v.closes[s * v.width + d + v.longest]! /
                v.closes[s * v.width + d + v.longest - period]! -
              1,
            rank,
            rps: (1 - rank / v.counts[d]!) * 100,
          };
    });
  }
  toJSON() {
    return { date: this.date, periods: this.periods, values: this.values };
  }
}
const lifecycleRpsValuesGetter = Object.getOwnPropertyDescriptor(
  LifecycleRpsPoint.prototype,
  "values",
)!.get!;

/** Same frozen cross section for every registered rank period. NaN in the
 * compact matrix means missing evidence, never a zero rank or zero return. */
export function buildLifecycleRps(
  stocks: readonly Csi800Stock[],
  calendar: readonly string[],
  periods: readonly number[] = lifecycleRpsPeriods,
  unknownSignals: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
) {
  if (
    !periods.length ||
    stocks.length > 10000 ||
    periods.some((p) => !Number.isInteger(p) || p < 1) ||
    new Set(periods).size !== periods.length ||
    new Set(stocks.map((s) => s.symbol)).size !== stocks.length ||
    new Set(calendar).size !== calendar.length ||
    calendar.some((d, i) => i > 0 && d <= calendar[i - 1]!)
  )
    throw new Error("Invalid lifecycle RPS pool/calendar/periods");
  const longest = Math.max(...periods),
    dates = calendar.slice(longest),
    width = calendar.length;
  const projected =
    stocks.length * width * 2 * 8 +
    stocks.length * dates.length * periods.length * 4;
  if (projected > sourceCacheBudget)
    throw new Error("Lifecycle RPS compact cache exceeds512MiB");
  const pointMetadata = stocks.length * dates.length * 96;
  const causalBars = stocks.reduce(
    (n, stock) => n + (stock.signalBars ? 0 : stock.bars.length * 128),
    0,
  );
  memoryBoundary(projected + pointMetadata + causalBars);
  const closes = new Float64Array(stocks.length * width).fill(NaN),
    volumes = new Float64Array(stocks.length * width).fill(NaN);
  const indices = new Map(calendar.map((d, i) => [d, i]));
  const signals = stocks.map((stock, s) => {
    orderedBars(stock.bars, stock.symbol);
    const bars = stock.signalBars ?? csi800SignalBars(stock);
    orderedBars(bars, `${stock.symbol}:signals`);
    if (
      bars.length !== stock.bars.length ||
      bars.some((b, i) => b.date !== stock.bars[i]!.date)
    )
      throw new Error("Raw and causal signal source dates differ");
    for (const bar of bars) {
      const i = indices.get(bar.date);
      if (i !== undefined) {
        closes[s * width + i] = bar.close;
        volumes[s * width + i] = bar.amount > 0 ? bar.volume : 0;
      }
    }
    return bars;
  });
  const ranks = new Float32Array(
      stocks.length * dates.length * periods.length,
    ).fill(NaN),
    counts = new Uint16Array(dates.length);
  const audits: { date: string; eligible: number; excluded: number }[] = [];
  for (let d = 0; d < dates.length; d++) {
    const i = d + longest;
    const eligible = stocks.flatMap((stock, s) => {
      const offset = s * width,
        current = closes[offset + i]!;
      const valid =
        current > 0 &&
        volumes[offset + i]! > 0 &&
        periods.every(
          (p) => closes[offset + i - p]! > 0 && volumes[offset + i - p]! > 0,
        ) &&
        ![calendar[i]!, ...periods.map((p) => calendar[i - p]!)].some((d) =>
          unknownSignals.get(stock.symbol)?.has(d),
        ) &&
        !stock.actions.some(
          (a) =>
            a.unsupported &&
            a.date > calendar[i - longest]! &&
            a.date <= calendar[i]!,
        );
      return valid ? [s] : [];
    });
    counts[d] = eligible.length;
    for (let p = 0; p < periods.length; p++) {
      const values = eligible.map((s) => ({
        symbol: stocks[s]!.symbol,
        return:
          closes[s * width + i]! / closes[s * width + i - periods[p]!]! - 1,
      }));
      const ranked = rankRps(values);
      for (const s of eligible)
        ranks[(s * dates.length + d) * periods.length + p] = ranked.get(
          stocks[s]!.symbol,
        )!.rank;
    }
    audits.push({
      date: dates[d]!,
      eligible: eligible.length,
      excluded: stocks.length - eligible.length,
    });
  }
  const rpsBySymbol = new Map<string, readonly FormulaRpsPoint[]>();
  const view: RpsView = {
    periods,
    ranks,
    closes,
    counts,
    dates: dates.length,
    width,
    longest,
  };
  stocks.forEach((stock, s) => {
    if (s % 32 === 0) memoryBoundary();
    const points = dates.map(
      (date, d) => new LifecycleRpsPoint(date, view, s, d),
    );
    rpsBySymbol.set(stock.symbol, points);
  });
  const rankBytes = Buffer.from(
    ranks.buffer,
    ranks.byteOffset,
    ranks.byteLength,
  );
  const symbolIndices = new Map(stocks.map((stock, i) => [stock.symbol, i]));
  return {
    signals,
    rpsBySymbol,
    rankBytes,
    isEligible: (symbol: string, date: string) => {
      const s = symbolIndices.get(symbol),
        i = indices.get(date);
      return (
        s !== undefined &&
        i !== undefined &&
        i >= longest &&
        !Number.isNaN(ranks[(s * dates.length + i - longest) * periods.length]!)
      );
    },
    audit: {
      version: "lifecycle-rps-1",
      algorithm:
        "quant-rps.rankRps (registered rankReturns name); average-one-based ties",
      periods: [...periods],
      pool: stocks.map((s) => s.symbol),
      poolHash: contentHash(stocks.map((s) => s.symbol)),
      calendarHash: contentHash(calendar),
      rankHash: bytesHash(rankBytes),
      layout:
        "Float32LE[symbol,date-after-max-warmup,period]; exact integer/half-integer ranks <=10000 only; RPS/returns reconstructed in Float64; NaN=excluded for all periods",
      dates: [...dates],
      coverage: audits,
      eligibility:
        "Every period uses the same common pool with positive-turnover, positive-price endpoints for ALL registered periods; source history is a conservative listing-age proxy; no historical ST claim",
      compactBytes: projected,
    },
  };
}
