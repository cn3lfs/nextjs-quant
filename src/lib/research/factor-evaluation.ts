/**
 * Cross-sectional single-factor evaluation, following alphalens definitions:
 * forward return P[t+h]/P[t]−1; daily Spearman IC; per-date equal-count
 * quantiles as pandas qcut (linear quantile edges, labels 1..Q, lowest bin
 * closed); quantile mean returns demeaned by the date's cross-sectional mean;
 * turnover |S_t \ S_{t−1}| / |S_t|; rank autocorrelation between consecutive
 * dates on common assets. Research description only, not tradable returns.
 */
export type FactorSeries = {
  symbol: string;
  /** Ascending trading dates. */
  dates: readonly string[];
  factor: readonly (number | null)[];
  /** Adjusted closes aligned with `dates`. */
  close: readonly (number | null)[];
};
export type FactorOptions = {
  horizons: readonly number[];
  quantiles: number;
  start: string;
  end: string;
};

function mean(xs: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < xs.length; i++) sum += xs[i]!;
  return sum / xs.length;
}
function std(xs: readonly number[]) {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
/** Average ranks, 1-based (ties share the mean rank). */
export function ranks(xs: ArrayLike<number>): Float64Array {
  const n = xs.length;
  // Sorting an index array avoids a tuple per element (GC-heavy at scale).
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => xs[a]! - xs[b]!);
  const out = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && xs[order[j]!] === xs[order[i]!]) j++;
    for (let k = i; k < j; k++) out[order[k]!] = (i + 1 + j) / 2;
    i = j;
  }
  return out;
}
function pearson(x: ArrayLike<number>, y: ArrayLike<number>) {
  const mx = mean(x),
    my = mean(y);
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
export const spearman = (x: readonly number[], y: readonly number[]) =>
  x.length < 2 ? null : pearson(ranks(x), ranks(y));

/** pandas.qcut(values, q, labels=False) + 1; null when edges are not unique. */
export function qcut(values: readonly number[], q: number): number[] | null {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const pos = p * (sorted.length - 1),
      lo = Math.floor(pos);
    return lo + 1 < sorted.length
      ? sorted[lo]! + (sorted[lo + 1]! - sorted[lo]!) * (pos - lo)
      : sorted[lo]!;
  };
  const edges = Array.from({ length: q + 1 }, (_, k) => at(k / q));
  for (let k = 1; k < edges.length; k++)
    if (edges[k] === edges[k - 1]) return null;
  return values.map((v) => {
    for (let k = 1; k <= q; k++) if (v <= edges[k]!) return k;
    return q;
  });
}

export function evaluateFactor(
  series: readonly FactorSeries[],
  o: FactorOptions,
) {
  // Columnar per date (security index, factor, forward returns with NaN for
  // missing): a full-market, multi-year panel stays in packed number arrays.
  type Day = { sym: number[]; factor: number[]; fwd: number[][] };
  const byDate = new Map<string, Day>();
  series.forEach((s, symbol) => {
    for (let i = 0; i < s.dates.length; i++) {
      const date = s.dates[i]!,
        f = s.factor[i],
        p = s.close[i];
      if (date < o.start || date > o.end || f == null || !Number.isFinite(f))
        continue;
      if (p == null || !(p > 0)) continue;
      let day = byDate.get(date);
      if (!day)
        byDate.set(
          date,
          (day = { sym: [], factor: [], fwd: o.horizons.map(() => []) }),
        );
      day.sym.push(symbol);
      day.factor.push(f);
      o.horizons.forEach((h, k) => {
        const q = s.close[i + h];
        day!.fwd[k]!.push(q != null && q > 0 ? q / p - 1 : NaN);
      });
    }
  });
  const dates = [...byDate.keys()].sort();
  const ic = o.horizons.map(() => [] as { date: string; value: number }[]);
  const quantileSums = o.horizons.map(() =>
    Array.from({ length: o.quantiles }, () => [] as number[]),
  );
  const turnover = { top: [] as number[], bottom: [] as number[] };
  const autocorrelation: number[] = [];
  let skipped = 0,
    previous: {
      top: Set<number>;
      bottom: Set<number>;
      rank: Map<number, number>;
    } | null = null;
  for (const date of dates) {
    const day = byDate.get(date)!;
    const n = day.factor.length;
    // alphalens needs enough names per date for the requested buckets.
    const labels = n >= o.quantiles * 2 ? qcut(day.factor, o.quantiles) : null;
    if (!labels) {
      // Like alphalens, turnover then compares with the last evaluated date.
      skipped++;
      continue;
    }
    // Factor ranks once per date; a horizon with missing returns (only near
    // the end of the window) ranks its own subset.
    const rankValues = ranks(day.factor);
    o.horizons.forEach((_, h) => {
      const fwd = day.fwd[h]!;
      const xs: number[] = [],
        ys: number[] = [],
        qs: number[] = [];
      for (let i = 0; i < n; i++)
        if (!Number.isNaN(fwd[i]!)) {
          xs.push(day.factor[i]!);
          ys.push(fwd[i]!);
          qs.push(labels[i]!);
        }
      if (xs.length >= 2) {
        const value =
          xs.length === n ? pearson(rankValues, ranks(ys)) : spearman(xs, ys);
        if (value !== null) ic[h]!.push({ date, value });
      }
      if (!ys.length) return;
      const m = mean(ys);
      const buckets = Array.from({ length: o.quantiles }, () => [] as number[]);
      ys.forEach((ret, i) => buckets[qs[i]! - 1]!.push(ret - m));
      buckets.forEach((b, q) => b.length && quantileSums[h]![q]!.push(mean(b)));
    });
    const top = new Set<number>(),
      bottom = new Set<number>();
    labels.forEach((label, i) => {
      if (label === o.quantiles) top.add(day.sym[i]!);
      if (label === 1) bottom.add(day.sym[i]!);
    });
    const rank = new Map(day.sym.map((s, i) => [s, rankValues[i]!]));
    if (previous) {
      const churn = (now: Set<number>, before: Set<number>) =>
        [...now].filter((s) => !before.has(s)).length / now.size;
      turnover.top.push(churn(top, previous.top));
      turnover.bottom.push(churn(bottom, previous.bottom));
      const common = [...rank.keys()].filter((s) => previous!.rank.has(s));
      const value =
        common.length >= 2
          ? pearson(
              common.map((s) => previous!.rank.get(s)!),
              common.map((s) => rank.get(s)!),
            )
          : null;
      if (value !== null) autocorrelation.push(value);
    }
    previous = { top, bottom, rank };
  }
  return {
    dates: dates.length,
    skippedDates: skipped,
    horizons: o.horizons.map((horizon, h) => {
      const values = ic[h]!.map((x) => x.value);
      const sd = std(values);
      const quantileMeans = quantileSums[h]!.map((xs) =>
        xs.length ? mean(xs) : null,
      );
      const top = quantileMeans.at(-1),
        bottom = quantileMeans[0];
      return {
        horizon,
        icMean: values.length ? mean(values) : null,
        icStd: sd,
        icIr: sd && values.length ? mean(values) / sd : null,
        icT:
          sd && values.length
            ? (mean(values) / sd) * Math.sqrt(values.length)
            : null,
        icPositiveRatio: values.length
          ? values.filter((v) => v > 0).length / values.length
          : null,
        icDays: values.length,
        quantileMeans,
        spread: top != null && bottom != null ? top - bottom : null,
        ic: ic[h]!,
      };
    }),
    turnover: {
      top: turnover.top.length ? mean(turnover.top) : null,
      bottom: turnover.bottom.length ? mean(turnover.bottom) : null,
    },
    rankAutocorrelation: autocorrelation.length ? mean(autocorrelation) : null,
  };
}
