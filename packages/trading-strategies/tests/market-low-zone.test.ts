import { describe, expect, it } from "vitest";
import {
  marketLowZoneSeries,
  type MarketLowZoneInput,
  type MarketLowZoneValuation,
} from "../src/market-low-zone.js";
import { historicalLowSeries } from "../src/historical-low.js";

function fixture(): MarketLowZoneInput {
  const dates = Array.from({ length: 2200 }, (_, i) =>
    new Date(Date.UTC(2010, 0, i + 1)).toISOString().slice(0, 10),
  );
  const bars = dates.map((date, i) => ({
    date,
    close: i === dates.length - 1 ? 25 : 100 + i / 100,
  }));
  const symbols = ["sh600001", "sh600002", "sh600003"];
  return {
    calendar: dates,
    index: {
      symbol: "sh000300",
      bars,
      source: "synthetic primary",
      hash: "index",
    },
    stocks: symbols.map((symbol, k) => ({
      symbol,
      bars:
        k < 2
          ? bars
          : bars.map((bar, i) => ({
              ...bar,
              close: i === 2199 ? 200 : bar.close,
            })),
      source: "synthetic fixed-basis stock prices",
      hash: `prices-${symbol}`,
    })),
    constituents: dates.map((date) => ({
      index: "sh000300",
      date,
      availableAt: `${date}T08:00:00+08:00`,
      basis: "point-in-time",
      symbols,
      source: "synthetic historical membership",
      hash: "membership",
    })),
    valuations: dates.flatMap((date, i) =>
      symbols.map((symbol, k) => ({
        date,
        symbol,
        availableAt: `${date}T15:00:00+08:00`,
        marketCap: [300, 400, 300][k]!,
        pe: k === 2 ? null : (20 + (2199 - i) / 100) * (k + 1),
        pb: k === 2 ? null : (2 + (2199 - i) / 1000) * (k + 1),
        source: "synthetic PIT daily valuation",
        hash: "valuation",
      })),
    ),
  };
}
const last = (input: MarketLowZoneInput) => marketLowZoneSeries(input).at(-1)!;
const changeLastFacts = (
  input: MarketLowZoneInput,
  change: (fact: MarketLowZoneValuation) => MarketLowZoneValuation,
) => ({
  ...input,
  valuations: input.valuations.map((fact) =>
    fact.date === input.calendar.at(-1) ? change(fact) : fact,
  ),
});

describe("registered market low-zone detector", () => {
  it("reuses price depth and empirical ranks; combines PE/PB by market-cap harmonic means", () => {
    const input = fixture();
    const row = last(input);
    expect(row).toMatchObject({
      role: "primary",
      entry: true,
      exit: false,
      depth: 3,
      targetShare: 0.4,
      breadth: 2 / 3,
      validPrices: 3,
      lowPrices: 2,
      coverage: { prices: 1, pe: 0.7, pb: 0.7 },
      confidence: "point-in-time",
      PITCertified: true,
      biasTags: [],
      missing: [],
    });
    expect(row.synthetic.pe).toBeCloseTo(700 / (300 / 20 + 400 / 40), 12);
    expect(row.synthetic.pb).toBeCloseTo(700 / (300 / 2 + 400 / 4), 12);
    expect(row.synthetic.pePercentile).toBeCloseTo(1 / 2200, 12);
    expect(row.priceObservation).toEqual(
      historicalLowSeries(input.index.bars).at(-1),
    );
    expect(row.sourceHashes).toEqual(
      [
        "index",
        "membership",
        ...input.stocks.map((s) => s.hash),
        "valuation",
      ].sort(),
    );
    expect(marketLowZoneSeries(input)[1000]!.entry).toBeNull();
  });

  it("does not replace unknown market-cap denominator or separate PE/PB coverage with smaller denominators", () => {
    const input = fixture();
    const missingCap = last(
      changeLastFacts(input, (fact) =>
        fact.symbol === "sh600003" ? { ...fact, marketCap: null } : fact,
      ),
    );
    expect(missingCap.entry).toBeNull();
    expect(missingCap.targetShare).toBeNull();
    expect(missingCap.coverage.pe).toBeNull();
    expect(missingCap.missing).toContain(
      "unknown-constituent-market-cap-denominator",
    );
    const missingPe = last(
      changeLastFacts(input, (fact) =>
        fact.symbol === "sh600002" ? { ...fact, pe: -2 } : fact,
      ),
    );
    expect(missingPe.coverage).toMatchObject({ pe: 0.3, pb: 0.7 });
    expect(missingPe.entry).toBeNull();
    expect(missingPe.synthetic.pe).toBeNull();
    const missingPb = last(
      changeLastFacts(input, (fact) =>
        fact.symbol === "sh600002" ? { ...fact, pb: 0 } : fact,
      ),
    );
    expect(missingPb.coverage).toMatchObject({ pe: 0.7, pb: 0.3 });
    expect(missingPb.exit).toBeNull();
  });

  it("requires date-matched visible snapshots and 60 positive valuation observations, never forward fills", () => {
    const input = fixture();
    const date = input.calendar.at(-1)!;
    expect(
      last({ ...input, constituents: input.constituents.slice(0, -1) }).entry,
    ).toBeNull();
    const lateMembership = last({
      ...input,
      constituents: input.constituents.map((m) =>
        m.date === date ? { ...m, availableAt: `${date}T15:00:01+08:00` } : m,
      ),
    });
    expect(lateMembership.missing).toContain("missing-visible-date-membership");
    const lateFacts = last(
      changeLastFacts(input, (fact) => ({
        ...fact,
        availableAt: `${date}T15:00:01+08:00`,
      })),
    );
    expect(lateFacts.entry).toBeNull();
    expect(lateFacts.synthetic.pe).toBeNull();
    expect(
      last({
        ...input,
        valuations: input.valuations.filter((f) => f.date !== date),
      }).entry,
    ).toBeNull();
    const short = last({
      ...input,
      valuations: input.valuations.filter(
        (f) => f.date >= input.calendar.at(-59)!,
      ),
    });
    expect(short.synthetic.peObservations).toBe(59);
    expect(short.missing).toContain("insufficient-positive-pe-history");
    expect(short.entry).toBeNull();
  });

  it("labels current membership lookahead while preserving explicitly authorized biased research signals", () => {
    const input = fixture();
    const current = last({
      ...input,
      constituents: input.constituents.map((row) => ({
        ...row,
        basis: "current-labelled",
        availableAt: "2026-11-16T00:00:00Z",
      })),
    });
    expect(current).toMatchObject({
      entry: true,
      depth: 3,
      confidence: "current-labelled-diagnostic",
      PITCertified: false,
      biasTags: ["current-membership-lookahead"],
    });
    const onlyHistoryBiased = last({
      ...input,
      constituents: input.constituents.map((row, i) =>
        i === 2198 ? { ...row, basis: "current-labelled" } : row,
      ),
    });
    expect(onlyHistoryBiased.PITCertified).toBe(false);
    expect(onlyHistoryBiased.biasTags).toContain(
      "current-membership-lookahead",
    );
  });

  it("does not turn missing constituent history into false breadth or borrow longer diagnostic history", () => {
    const input = fixture();
    const absent = last({ ...input, stocks: input.stocks.slice(0, 1) });
    expect(absent.coverage.prices).toBe(1 / 3);
    expect(absent.breadth).toBe(1);
    expect(absent.entry).toBeNull();
    const primary = last({
      ...input,
      index: { ...input.index, bars: input.index.bars.slice(-1000) },
    });
    const diagnostic = last({
      ...input,
      index: { ...input.index, symbol: "sh000001" },
      constituents: input.constituents.map((snapshot) => ({
        ...snapshot,
        index: "sh000001",
      })),
    });
    expect(primary.entry).toBeNull();
    expect(diagnostic).toMatchObject({ role: "diagnostic", entry: true });
    const noDiagnosticMembership = last({
      ...input,
      index: { ...input.index, symbol: "sh000001" },
    });
    expect(noDiagnosticMembership.entry).toBeNull();
    expect(noDiagnosticMembership.priceObservation!.depth).toBe(3);
    expect(noDiagnosticMembership.missing).toContain(
      "missing-visible-date-membership",
    );
    const gap = last({
      ...input,
      stocks: input.stocks.map((s) => ({
        ...s,
        bars: s.bars.filter((_bar, i) => i !== 2000),
      })),
    });
    expect(gap.validPrices).toBe(0);
    expect(gap.entry).toBeNull();
  });

  it("uses registered breadth/valuation neighbors and existing recovery without inventing new thresholds", () => {
    const input = fixture();
    const noneLow = {
      ...input,
      stocks: input.stocks.map((s) => ({
        ...s,
        bars: s.bars.map((b, i) => (i === 2199 ? { ...b, close: 200 } : b)),
      })),
    };
    expect(last(noneLow)).toMatchObject({
      entry: false,
      depth: 0,
      targetShare: 0,
    });
    // Exactly 60% of known market cap remains valid: threshold is inclusive.
    const sixty = changeLastFacts(input, (f) => ({
      ...f,
      marketCap: f.symbol === "sh600003" ? 1400 / 3 : f.marketCap,
    }));
    expect(last(sixty).coverage.pe).toBeCloseTo(0.6, 12);
    expect(last(sixty).entry).toBe(true);
    // This last valuation ranks between the registered 27% and 30% bounds.
    // Compare the original empirical <= ranks; do not pick a new threshold.
    const boundary = changeLastFacts(input, (f) => {
      const multiplier = f.symbol === "sh600001" ? 1 : 2;
      return f.symbol === "sh600003"
        ? f
        : {
            ...f,
            pe: 26.5 * multiplier,
            pb: 2.65 * multiplier,
          };
    });
    const base = last(boundary);
    expect(base.synthetic.pePercentile).toBeGreaterThan(0.27);
    expect(base.synthetic.pePercentile).toBeLessThanOrEqual(0.3);
    expect(base.entry).toBe(true);
    expect(
      marketLowZoneSeries(boundary, {
        years: 9,
        minimumBars: 1000,
        minimumBreadth: 0.27,
        maximumValuationPercentile: 0.27,
      }).at(-1)!.entry,
    ).toBe(false);
    const recovered = {
      ...input,
      index: {
        ...input.index,
        bars: input.index.bars.map((b, i) =>
          i === 2199 ? { ...b, close: 130 } : b,
        ),
      },
    };
    expect(last(recovered)).toMatchObject({
      entry: false,
      exit: true,
      depth: 0,
    });
    expect(
      marketLowZoneSeries(input, {
        years: 9,
        minimumBars: 1000,
        minimumBreadth: 0.27,
        maximumValuationPercentile: 0.27,
      }).at(-1)!.entry,
    ).toBe(true);
    expect(
      marketLowZoneSeries(input, { recoveryPercentile: 0.54 }).at(-1)!.exit,
    ).toBe(false);
  });

  it("appended future evidence cannot change historical outputs and invalid duplicates fail explicitly", () => {
    const input = fixture();
    const prefix = {
      ...input,
      calendar: input.calendar.slice(0, -1),
      index: { ...input.index, bars: input.index.bars.slice(0, -1) },
      stocks: input.stocks.map((s) => ({ ...s, bars: s.bars.slice(0, -1) })),
      constituents: input.constituents.slice(0, -1),
      valuations: input.valuations.filter(
        (v) => v.date !== input.calendar.at(-1),
      ),
    };
    expect(marketLowZoneSeries(input).slice(0, -1)).toEqual(
      marketLowZoneSeries(prefix),
    );
    expect(() =>
      marketLowZoneSeries({
        ...input,
        valuations: [...input.valuations, input.valuations[0]!],
      }),
    ).toThrow("Duplicate");
    expect(() =>
      marketLowZoneSeries({ ...input, calendar: ["2026-02-30"] }),
    ).toThrow("calendar");
    expect(() =>
      marketLowZoneSeries({ ...input, index: { ...input.index, hash: "" } }),
    ).toThrow("content hash");
  });
});
