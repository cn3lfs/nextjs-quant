import { z } from "zod";
import {
  historicalLowConfigSchema,
  historicalLowSeries,
  type LowZoneFact,
  type LowZoneObservation,
} from "./historical-low.js";

export const marketLowZoneConfigSchema = historicalLowConfigSchema.extend({
  minimumBreadth: z.number().min(0).max(1).default(0.3),
  minimumCoverage: z.number().min(0).max(1).default(0.6),
  maximumValuationPercentile: z.number().min(0).max(1).default(0.3),
  benchmark: z.literal("sh000300").default("sh000300"),
  diagnosticBenchmark: z.literal("sh000001").default("sh000001"),
});
export type MarketLowZoneConfig = z.input<typeof marketLowZoneConfigSchema>;
type Price = { date: string; close: number };
type Source = { source: string; hash: string };
export type MarketLowZoneMembership = Source & {
  index: "sh000300" | "sh000001";
  date: string;
  availableAt: string;
  basis: "point-in-time" | "current-labelled";
  symbols: readonly string[];
};
export type MarketLowZoneValuation = Source & {
  date: string;
  availableAt: string;
  symbol: string;
  marketCap: number | null;
  pe: number | null;
  pb: number | null;
};
export type MarketLowZoneInput = {
  /** Complete trading calendar, including price/valuation warmup. One index
   * per invocation: the longer diagnostic index never extends primary history. */
  calendar: readonly string[];
  index: Source & { symbol: "sh000300" | "sh000001"; bars: readonly Price[] };
  stocks: readonly (Source & { symbol: string; bars: readonly Price[] })[];
  /** Exact-date snapshots, never carried backward or forward. Current-labelled
   * membership permits explicitly biased diagnostics, not PIT certification. */
  constituents: readonly MarketLowZoneMembership[];
  /** Exact-date, historically valued PE/PB and market cap. Report-period values
   * are not substitutes; the adapter must supply their true availability. */
  valuations: readonly MarketLowZoneValuation[];
};
export type MarketLowZoneObservation = {
  date: string;
  index: MarketLowZoneInput["index"]["symbol"];
  role: "primary" | "diagnostic";
  entry: boolean | null;
  exit: boolean | null;
  depth: LowZoneObservation["depth"];
  targetShare: number | null;
  breadth: number | null;
  constituents: number;
  validPrices: number;
  lowPrices: number;
  priceObservation: LowZoneObservation | null;
  synthetic: {
    pe: number | null;
    pb: number | null;
    pePercentile: number | null;
    pbPercentile: number | null;
    peObservations: number;
    pbObservations: number;
  };
  /** Valuation coverage is positive-ratio market cap / ALL constituent market
   * cap. A missing cap makes that denominator unknown, never silently smaller. */
  coverage: { prices: number | null; pe: number | null; pb: number | null };
  missing: string[];
  sourceHashes: string[];
  confidence: "point-in-time" | "current-labelled-diagnostic" | "unknown";
  PITCertified: boolean;
  biasTags: string[];
};
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (date: string) =>
  datePattern.test(date) &&
  Number.isFinite(Date.parse(date)) &&
  new Date(date).toISOString().slice(0, 10) === date;
const closeAt = (date: string) => Date.parse(`${date}T15:00:00+08:00`);
const positive = (value: number | null | undefined): value is number =>
  value != null && Number.isFinite(value) && value > 0;
function trailingStart(date: string, years: number) {
  const first = new Date(date);
  first.setUTCFullYear(first.getUTCFullYear() - years);
  return first.toISOString().slice(0, 10);
}
function requireSource(value: Source) {
  if (!value.source.trim() || !value.hash.trim())
    throw new Error("Market low-zone requires source and content hash");
}
function requireSnapshot(
  value: Source & { date: string; availableAt: string },
) {
  requireSource(value);
  if (!validDate(value.date) || !Number.isFinite(Date.parse(value.availableAt)))
    throw new Error("Invalid market low-zone snapshot date / availableAt");
}
/** Reuse the existing exact empirical <= rank, five-calendar-year minimum,
 * drawdown/depth/share and recovery definitions. No new price thresholds. */
export function marketLowZoneSeries(
  input: MarketLowZoneInput,
  config: MarketLowZoneConfig = {},
): MarketLowZoneObservation[] {
  const options = marketLowZoneConfigSchema.parse(config);
  if (
    input.index.symbol !== options.benchmark &&
    input.index.symbol !== options.diagnosticBenchmark
  )
    throw new Error("Unregistered market low-zone index");
  const priceConfig = {
    years: options.years,
    minimumBars: options.minimumBars,
    recoveryPercentile: options.recoveryPercentile,
  };
  if (
    input.calendar.some(
      (date, i) =>
        !validDate(date) || (i > 0 && date <= input.calendar[i - 1]!),
    )
  )
    throw new Error("Invalid market low-zone trading calendar");
  const calendar = new Set(input.calendar);
  const calendarIndex = new Map(input.calendar.map((date, i) => [date, i]));
  const history = (series: Source & { bars: readonly Price[] }) => {
    requireSource(series);
    if (series.bars.some((bar) => !calendar.has(bar.date)))
      throw new Error(
        "Price history falls outside the supplied trading calendar",
      );
    const rows = historicalLowSeries(series.bars, priceConfig);
    const byDate = new Map(rows.map((row) => [row.date, row]));
    const present = new Set(series.bars.map((bar) => bar.date));
    const firstPrice = series.bars[0]?.date;
    const firstPriceIndex = firstPrice ? calendarIndex.get(firstPrice)! : 0;
    const gapPrefix = [0];
    for (const date of input.calendar)
      gapPrefix.push(gapPrefix.at(-1)! + (present.has(date) ? 0 : 1));
    // Before the first price there is no claimed history. Once it begins,
    // a missing expected session remains a gap until it exits the window.
    let first = 0;
    return input.calendar.map((date, i) => {
      const start = trailingStart(date, options.years);
      while (input.calendar[first]! < start) first++;
      const coveredStart = Math.max(first, firstPriceIndex);
      const row = byDate.get(date) ?? null;
      return {
        row,
        complete:
          row !== null &&
          row.depth !== null &&
          gapPrefix[i + 1]! === gapPrefix[coveredStart]!,
      };
    });
  };
  requireSource(input.index);
  const index = history(input.index);
  const stocks = new Map<string, ReturnType<typeof history>>();
  const stockSources = new Map<string, Source>();
  for (const stock of input.stocks) {
    if (stocks.has(stock.symbol))
      throw new Error("Duplicate stock price history");
    stocks.set(stock.symbol, history(stock));
    stockSources.set(stock.symbol, stock);
  }
  const memberships = new Map<string, MarketLowZoneMembership>();
  for (const snapshot of input.constituents) {
    requireSnapshot(snapshot);
    const key = `${snapshot.index}:${snapshot.date}`;
    if (
      memberships.has(key) ||
      new Set(snapshot.symbols).size !== snapshot.symbols.length ||
      snapshot.symbols.some((symbol) => !symbol) ||
      (snapshot.index !== options.benchmark &&
        snapshot.index !== options.diagnosticBenchmark) ||
      (snapshot.basis !== "point-in-time" &&
        snapshot.basis !== "current-labelled")
    )
      throw new Error("Duplicate market low-zone membership date / symbol");
    memberships.set(key, snapshot);
  }
  const valuations = new Map<string, Map<string, MarketLowZoneValuation>>();
  for (const fact of input.valuations) {
    requireSnapshot(fact);
    if (!fact.symbol)
      throw new Error("Missing market low-zone valuation symbol");
    if (
      [fact.marketCap, fact.pe, fact.pb].some(
        (v) => v !== null && !Number.isFinite(v),
      )
    )
      throw new Error("Nonfinite market low-zone valuation");
    const date = valuations.get(fact.date) ?? new Map();
    if (date.has(fact.symbol))
      throw new Error("Duplicate market low-zone valuation");
    date.set(fact.symbol, fact);
    valuations.set(fact.date, date);
  }
  const aggregates = input.calendar.map((date, i) => {
    const missing: string[] = [];
    const snapshot = memberships.get(`${input.index.symbol}:${date}`);
    const hashes = new Set([input.index.hash]);
    const currentLabel = snapshot?.basis === "current-labelled";
    const visible =
      snapshot &&
      (currentLabel || Date.parse(snapshot.availableAt) <= closeAt(date));
    if (snapshot) hashes.add(snapshot.hash);
    if (!visible || !snapshot.symbols.length)
      missing.push("missing-visible-date-membership");
    const symbols = visible ? snapshot.symbols : [];
    let validPrices = 0,
      lowPrices = 0;
    for (const symbol of symbols) {
      const source = stockSources.get(symbol);
      if (source) hashes.add(source.hash);
      const observation = stocks.get(symbol)?.[i];
      if (!observation?.complete) continue;
      validPrices++;
      if (observation.row!.depth! > 0) lowPrices++;
    }
    const priceCoverage = symbols.length ? validPrices / symbols.length : null;
    if (priceCoverage === null || priceCoverage < options.minimumCoverage)
      missing.push("insufficient-constituent-price-coverage");
    const facts = symbols.map((symbol) => {
      const fact = valuations.get(date)?.get(symbol);
      if (fact) hashes.add(fact.hash);
      return fact && Date.parse(fact.availableAt) <= closeAt(date)
        ? fact
        : null;
    });
    const totalCap =
      facts.length && facts.every((fact) => positive(fact?.marketCap))
        ? facts.reduce((sum, fact) => sum + fact!.marketCap!, 0)
        : null;
    if (totalCap === null)
      missing.push("unknown-constituent-market-cap-denominator");
    const combine = (field: "pe" | "pb") => {
      let cap = 0,
        denominator = 0;
      for (const fact of facts) {
        if (!positive(fact?.marketCap) || !positive(fact?.[field])) continue;
        cap += fact.marketCap;
        denominator += fact.marketCap / fact[field];
      }
      const coverage = totalCap === null ? null : cap / totalCap;
      if (
        coverage === null ||
        coverage < options.minimumCoverage ||
        denominator <= 0
      ) {
        missing.push(`insufficient-${field}-market-cap-coverage`);
        return { value: null, coverage };
      }
      return { value: cap / denominator, coverage };
    };
    const pe = combine("pe"),
      pb = combine("pb");
    return {
      date,
      missing,
      symbols: symbols.length,
      validPrices,
      lowPrices,
      breadth: validPrices ? lowPrices / validPrices : null,
      priceCoverage,
      pe,
      pb,
      currentLabel,
      hashes,
    };
  });
  const facts: LowZoneFact[] = aggregates.map((row) => ({
    date: row.date,
    availableAt: row.date,
    pe: row.pe.value,
    pb: row.pb.value,
    temperature: null,
    source: "date-matched market-cap harmonic constituent valuation",
    confidence: row.currentLabel ? "approximate" : "verified",
  }));
  const valued = new Map(
    historicalLowSeries(input.index.bars, priceConfig, facts).map((row) => [
      row.date,
      row,
    ]),
  );
  let historyStart = 0;
  const historicalHashes = new Map<string, number>();
  let biasedValuations = 0;
  const addValuationSources = (
    row: (typeof aggregates)[number],
    delta: 1 | -1,
  ) => {
    if (row.pe.value === null && row.pb.value === null) return;
    if (row.currentLabel) biasedValuations += delta;
    for (const hash of row.hashes) {
      const count = (historicalHashes.get(hash) ?? 0) + delta;
      if (count === 0) historicalHashes.delete(hash);
      else historicalHashes.set(hash, count);
    }
  };
  return aggregates.map((aggregate, i) => {
    const date = aggregate.date;
    const observation = index[i]!;
    const valuation = valued.get(date);
    const missing = [...aggregate.missing];
    if (!observation.complete) missing.push("insufficient-index-price-history");
    if (valuation?.pe.value == null)
      missing.push("insufficient-positive-pe-history");
    if (valuation?.pb.value == null)
      missing.push("insufficient-positive-pb-history");
    const first = trailingStart(date, options.years);
    // A rolling reference count retains provenance of every observation that
    // actually enters the trailing valuation ranks, without future hashes.
    addValuationSources(aggregate, 1);
    while (aggregates[historyStart]!.date < first) {
      addValuationSources(aggregates[historyStart]!, -1);
      historyStart++;
    }
    const sourceHashes = new Set([
      ...aggregate.hashes,
      ...historicalHashes.keys(),
    ]);
    const currentLabel = aggregate.currentLabel || biasedValuations > 0;
    const known = missing.length === 0;
    const corroborated =
      known &&
      aggregate.breadth! >= options.minimumBreadth &&
      valuation!.pe.value! <= options.maximumValuationPercentile &&
      valuation!.pb.value! <= options.maximumValuationPercentile;
    const depth = known ? (corroborated ? observation.row!.depth : 0) : null;
    return {
      date,
      index: input.index.symbol,
      role: input.index.symbol === options.benchmark ? "primary" : "diagnostic",
      entry: known ? depth! > 0 : null,
      exit: known ? valuation!.recovery : null,
      depth,
      targetShare: known
        ? corroborated
          ? observation.row!.targetShare
          : 0
        : null,
      breadth: aggregate.breadth,
      constituents: aggregate.symbols,
      validPrices: aggregate.validPrices,
      lowPrices: aggregate.lowPrices,
      priceObservation: observation.row,
      synthetic: {
        pe: aggregate.pe.value,
        pb: aggregate.pb.value,
        pePercentile: valuation?.pe.value ?? null,
        pbPercentile: valuation?.pb.value ?? null,
        peObservations: valuation?.pe.observations ?? 0,
        pbObservations: valuation?.pb.observations ?? 0,
      },
      coverage: {
        prices: aggregate.priceCoverage,
        pe: aggregate.pe.coverage,
        pb: aggregate.pb.coverage,
      },
      missing,
      sourceHashes: [...sourceHashes].sort(),
      confidence: !known
        ? "unknown"
        : currentLabel
          ? "current-labelled-diagnostic"
          : "point-in-time",
      PITCertified: known && !currentLabel,
      biasTags: currentLabel ? ["current-membership-lookahead"] : [],
    };
  });
}
