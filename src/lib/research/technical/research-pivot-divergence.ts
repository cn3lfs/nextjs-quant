import type { Bar } from "../../domain";
import { confirmedExtrema } from "../../indicators";

/** Strict 3/3 price pivots; indicator is sampled at the price endpoint.
 * A signal belongs to the confirmation date, never the endpoint date. */
export function pivotDivergenceSeries(
  bars: readonly Bar[],
  line: readonly (number | null)[],
) {
  const { extrema, ambiguousIndices } = confirmedExtrema(bars);
  return bars.map((bar, i) => {
    const valid = (j: number) => {
      const b = bars[j]!;
      return (
        b.volume > 0 &&
        [b.open, b.high, b.low, b.close, line[j]].every(
          (v) => v != null && Number.isFinite(v),
        ) &&
        b.low > 0 &&
        b.high > b.low &&
        b.high >= Math.max(b.open, b.close) &&
        b.low <= Math.min(b.open, b.close)
      );
    };
    const evaluate = (kind: "high" | "low") => {
      const pivots = extrema
        .filter((p) => p.kind === kind && p.confirmedAt <= bar.date)
        .slice(-3);
      const latest = pivots.at(-1);
      if (!latest || latest.confirmedAt !== bar.date)
        return { single: false, double: false, pivots: [] };
      const pair = (a: typeof latest, b: typeof latest) => {
        if (ambiguousIndices.some((j) => j >= a.index && j <= b.index))
          return false;
        for (let j = a.index - 3; j <= i; j++) if (!valid(j)) return false;
        return kind === "high"
          ? b.price > a.price && line[b.index]! <= line[a.index]!
          : b.price < a.price && line[b.index]! >= line[a.index]!;
      };
      const single = pivots.length >= 2 && pair(pivots.at(-2)!, latest);
      return {
        single,
        double: single && pivots.length === 3 && pair(pivots[0]!, pivots[1]!),
        pivots,
      };
    };
    return { date: bar.date, top: evaluate("high"), bottom: evaluate("low") };
  });
}
