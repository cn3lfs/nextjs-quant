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
  calendar?: readonly string[];
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
  if (xs.every((v) => v === xs[0])) return 0;
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
export function pearson(x: ArrayLike<number>, y: ArrayLike<number>) {
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
  return sxx && syy
    ? Math.min(1, Math.max(-1, sxy / Math.sqrt(sxx * syy)))
    : null;
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

export function forwardReturn(
  start: number | null | undefined,
  end: number | null | undefined,
) {
  return start != null &&
    end != null &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start > 0 &&
    end > 0
    ? end / start - 1
    : NaN;
}
export function icStatistics(values: readonly number[]) {
  const average = values.length ? mean(values) : null,
    sd = std(values);
  return {
    mean: average,
    std: sd,
    icir: sd && average !== null ? average / sd : null,
    positiveRatio: values.length
      ? values.filter((v) => v > 0).length / values.length
      : null,
    days: values.length,
  };
}
type Point = { date: string; value: number };
/** Stream one frozen cross-section at a time to avoid holding a second market panel. */
export function factorAccumulator(
  o: FactorOptions,
  mode: "alpha" | "single-factor" = "alpha",
) {
  const horizons = o.horizons.map((horizon) => ({
    horizon,
    ic: [] as Point[],
    pearsonIC: [] as Point[],
    groups: [] as {
      date: string;
      counts: number[];
      returns: (number | null)[];
      excess: (number | null)[];
      spread: number | null;
    }[],
    wealth: Array<number | null>(o.quantiles).fill(null),
  }));
  const turnover = { top: [] as number[], bottom: [] as number[] },
    auto: number[] = [];
  let dates = 0,
    skippedDates = 0;
  let previous:
    | {
        index: number;
        top: Set<number>;
        bottom: Set<number>;
        rank: Map<number, number>;
      }
    | undefined;
  function add(
    date: string,
    index: number,
    names: number[],
    factors: number[],
    returns: (horizon: number, symbol: number) => number,
  ) {
    if (names.length) dates++;
    const labels =
      factors.length >= o.quantiles * 2 ? qcut(factors, o.quantiles) : null;
    if (!labels && names.length) skippedDates++;
    const rank = ranks(factors);
    for (const h of horizons) {
      const xs: number[] = [],
        ys: number[] = [];
      const sums = Array<number>(o.quantiles).fill(0),
        counts = Array<number>(o.quantiles).fill(0);
      names.forEach((symbol, i) => {
        const y = returns(h.horizon, symbol);
        if (!Number.isFinite(y)) return;
        xs.push(factors[i]!);
        ys.push(y);
        if (labels) {
          const q = labels[i]! - 1;
          sums[q] = sums[q]! + y;
          counts[q] = counts[q]! + 1;
        }
      });
      if (xs.length >= 2) {
        const raw = pearson(xs, ys),
          ranked =
            xs.length === names.length
              ? pearson(rank, ranks(ys))
              : spearman(xs, ys);
        if (raw !== null) h.pearsonIC.push({ date, value: raw });
        if (ranked !== null && (mode === "alpha" || labels))
          h.ic.push({ date, value: ranked });
      }
      const baseline = ys.length ? mean(ys) : null;
      const group = sums.map((v, i) => (counts[i] ? v / counts[i]! : null));
      const excess = group.map((v) =>
        v === null || baseline === null ? null : v - baseline,
      );
      const bottom = group[0],
        top = group.at(-1);
      h.groups.push({
        date,
        counts,
        returns: group,
        excess,
        spread: top != null && bottom != null ? top - bottom : null,
      });
      // Disjoint h-session cohorts anchored at the first decision. Missing legs stay unobserved.
      if (index % h.horizon === 0)
        group.forEach((v, i) => {
          if (v !== null) h.wealth[i] = (h.wealth[i] ?? 1) * (1 + v);
        });
    }
    // The original single-factor report compares consecutive bucketed sections.
    if (mode === "single-factor" && !labels) return;
    const currentRank = new Map(names.map((s, i) => [s, rank[i]!]));
    const top = new Set<number>(),
      bottom = new Set<number>();
    labels?.forEach((q, i) => {
      if (q === 1) bottom.add(names[i]!);
      if (q === o.quantiles) top.add(names[i]!);
    });
    if (
      previous &&
      (mode === "single-factor" || previous.index === index - 1)
    ) {
      const churn = (a: Set<number>, b: Set<number>) =>
        [...a].filter((s) => !b.has(s)).length / a.size;
      if (top.size && previous.top.size)
        turnover.top.push(churn(top, previous.top));
      if (bottom.size && previous.bottom.size)
        turnover.bottom.push(churn(bottom, previous.bottom));
      const prev = previous.rank,
        common = names.filter((s) => prev.has(s));
      const corr = pearson(
        common.map((s) => prev.get(s)!),
        common.map((s) => currentRank.get(s)!),
      );
      if (corr !== null) auto.push(corr);
    }
    previous = { index, top, bottom, rank: currentRank };
  }
  const nullableMean = (xs: (number | null)[]) => {
    const valid = xs.filter((n): n is number => n !== null);
    return valid.length ? mean(valid) : null;
  };
  function result() {
    return {
      dates,
      skippedDates,
      horizons: horizons.map((h) => {
        const rankIC = icStatistics(h.ic.map((p) => p.value));
        const groupedMean = (key: "returns" | "excess") =>
          h.wealth.map((_, i) => nullableMean(h.groups.map((g) => g[key][i]!)));
        const quantileMeans = groupedMean("excess");
        const top = quantileMeans.at(-1),
          bottom = quantileMeans[0];
        const meanTopBottom = nullableMean(h.groups.map((g) => g.spread));
        return {
          horizon: h.horizon,
          icMean: rankIC.mean,
          icStd: rankIC.std,
          icIr: rankIC.icir,
          icT:
            rankIC.icir === null ? null : rankIC.icir * Math.sqrt(rankIC.days),
          icPositiveRatio: rankIC.positiveRatio,
          icDays: rankIC.days,
          ic: h.ic,
          rankIC,
          pearsonIC: h.pearsonIC,
          pearson: icStatistics(h.pearsonIC.map((p) => p.value)),
          quantileMeans,
          quantileRawMeans: groupedMean("returns"),
          quantileCumulative: h.wealth.map((w) => (w === null ? null : w - 1)),
          spread:
            mode === "alpha"
              ? meanTopBottom
              : top != null && bottom != null
                ? top - bottom
                : null,
          groups: h.groups,
        };
      }),
      turnover: {
        top: nullableMean(turnover.top),
        bottom: nullableMean(turnover.bottom),
      },
      rankAutocorrelation: nullableMean(auto),
    };
  }
  return { add, result };
}

export function evaluateFactor(
  series: readonly FactorSeries[],
  o: FactorOptions,
) {
  const days = new Set<string>();
  if (!o.calendar) for (const s of series) for (const d of s.dates) days.add(d);
  const calendar = o.calendar ?? [...days].sort();
  if (calendar.some((d, i) => i > 0 && d <= calendar[i - 1]!))
    throw new Error("市场交易日历必须唯一且升序");
  const dateIndex = new Map(calendar.map((d, i) => [d, i]));
  const aligned = series.map((s) => {
    const positions = new Int32Array(calendar.length).fill(-1);
    for (let i = 0; i < s.dates.length; i++) {
      const t = dateIndex.get(s.dates[i]!);
      if (t !== undefined) positions[t] = i;
    }
    return positions;
  });
  const metrics = factorAccumulator(o, "single-factor");
  let offset = 0;
  for (const [t, date] of calendar.entries()) {
    if (date < o.start || date > o.end) continue;
    const names: number[] = [],
      factors: number[] = [];
    series.forEach((s, k) => {
      const i = aligned[k]![t]!;
      if (i < 0) return;
      const x = s.factor[i],
        p = s.close[i];
      if (
        x == null ||
        !Number.isFinite(x) ||
        p == null ||
        !Number.isFinite(p) ||
        p <= 0
      )
        return;
      names.push(k);
      factors.push(x);
    });
    metrics.add(date, offset++, names, factors, (h, k) => {
      // Advance by market sessions, including days with no quotes in any series.
      const idx = aligned[k]![t + h];
      return idx === undefined || idx < 0
        ? NaN
        : forwardReturn(
            series[k]!.close[aligned[k]![t]!],
            series[k]!.close[idx],
          );
    });
  }
  return metrics.result();
}
