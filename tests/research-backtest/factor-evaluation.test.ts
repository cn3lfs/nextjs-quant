import { describe, expect, it } from "vitest";
import {
  evaluateFactor,
  qcut,
  spearman,
  type FactorSeries,
} from "~/lib/research/factor-evaluation";

describe("alphalens building blocks", () => {
  it("spearman averages tied ranks like scipy.stats.spearmanr", () => {
    expect(spearman([1, 2, 2, 3], [1, 3, 2, 4])).toBeCloseTo(
      0.9486832980505138,
      14,
    );
    expect(spearman([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 14);
  });
  it("qcut matches pandas.qcut(labels=False)+1", () => {
    // pd.qcut(range(1, 11), 5, labels=False) + 1
    expect(qcut([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5)).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5,
    ]);
    // Edges 1,3,5,7 (linear interpolation): (≤3], (3,5], (5,7].
    expect(qcut([7, 1, 5, 3, 2, 6, 4], 3)).toEqual([3, 1, 2, 1, 1, 3, 2]);
    // Duplicate edges raise in pandas; here the date is skipped.
    expect(qcut([1, 1, 1, 1, 2, 2], 3)).toBeNull();
  });
});

/** n securities over d days; close grows by `drift(symbol index)` per day. */
function panel(
  n: number,
  d: number,
  factor: (s: number, day: number) => number,
  drift: (s: number) => number,
): FactorSeries[] {
  const dates = Array.from(
    { length: d },
    (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`,
  );
  return Array.from({ length: n }, (_, s) => ({
    symbol: `sz${String(s).padStart(6, "0")}`,
    dates,
    factor: dates.map((_, day) => factor(s, day)),
    close: dates.map((_, day) => 10 * (1 + drift(s)) ** day),
  }));
}
const options = {
  horizons: [1, 5],
  quantiles: 5,
  start: "2026-01-01",
  end: "2026-01-31",
};

describe("evaluateFactor", () => {
  it("a factor ranking exactly like future returns has IC 1 and ordered quantiles", () => {
    const result = evaluateFactor(
      panel(
        20,
        20,
        (s) => s,
        (s) => s / 1000,
      ),
      options,
    );
    const h1 = result.horizons[0]!;
    expect(h1.icMean).toBeCloseTo(1, 12);
    expect(h1.icPositiveRatio).toBe(1);
    // Days with a 1-day forward return: the last day has none.
    expect(h1.icDays).toBe(19);
    const q = h1.quantileMeans.map((v) => v!);
    for (let i = 1; i < q.length; i++) expect(q[i]!).toBeGreaterThan(q[i - 1]!);
    // Demeaned buckets of equal size sum to zero.
    expect(q.reduce((s, v) => s + v, 0)).toBeCloseTo(0, 12);
    expect(h1.spread).toBeGreaterThan(0);
    // A constant ordering never changes quantile membership.
    expect(result.turnover).toEqual({ top: 0, bottom: 0 });
    expect(result.rankAutocorrelation).toBeCloseTo(1, 12);
  });

  it("the reversed factor has IC −1; the 5-day horizon uses t+5 closes", () => {
    const result = evaluateFactor(
      panel(
        20,
        20,
        (s) => -s,
        (s) => s / 1000,
      ),
      options,
    );
    expect(result.horizons[0]!.icMean).toBeCloseTo(-1, 12);
    expect(result.horizons[1]!.icMean).toBeCloseTo(-1, 12);
    expect(result.horizons[1]!.icDays).toBe(15);
  });

  it("measures turnover when the ranking flips every day", () => {
    const result = evaluateFactor(
      panel(
        10,
        6,
        (s, day) => (day % 2 ? -s : s),
        () => 0.001,
      ),
      { ...options, horizons: [1] },
    );
    // Top and bottom quantiles swap completely on each date.
    expect(result.turnover).toEqual({ top: 1, bottom: 1 });
    expect(result.rankAutocorrelation).toBeCloseTo(-1, 12);
  });

  it("skips dates with too few names or tied edges and honours the window", () => {
    const result = evaluateFactor(
      panel(
        8,
        10,
        () => 1,
        () => 0.001,
      ),
      { ...options, start: "2026-01-03", end: "2026-01-07" },
    );
    expect(result.dates).toBe(5);
    expect(result.skippedDates).toBe(5);
    expect(result.horizons[0]!.icMean).toBeNull();
  });

  it("drops non-positive or missing prices instead of inventing returns", () => {
    const series = panel(
      10,
      5,
      (s) => s,
      (s) => s / 1000,
    );
    series[0] = { ...series[0]!, close: [10, null, 0, 10, 10] };
    const result = evaluateFactor(series, { ...options, horizons: [1] });
    expect(result.horizons[0]!.icMean).toBeCloseTo(1, 12);
  });
});
