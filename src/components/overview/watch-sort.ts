export type WatchSort = "saved" | "gain" | "loss";

/**
 * Stable watchlist order for the saved/gain/loss segmented control. Unknown
 * changes (missing quote, null or non-finite) stay last in both directions;
 * equal changes keep the saved order. The input array is never mutated.
 */
export function sortWatchSymbols(
  symbols: readonly string[],
  changeOf: (symbol: string) => number | null,
  sort: WatchSort,
): readonly string[] {
  if (sort === "saved") return symbols;
  const ranked = symbols.map((symbol, index) => {
    const raw = changeOf(symbol);
    return {
      symbol,
      index,
      change: raw !== null && Number.isFinite(raw) ? raw : null,
    };
  });
  ranked.sort((a, b) => {
    if (a.change === null || b.change === null) {
      if (a.change === b.change) return a.index - b.index;
      return a.change === null ? 1 : -1;
    }
    const delta = sort === "gain" ? b.change - a.change : a.change - b.change;
    return delta !== 0 ? delta : a.index - b.index;
  });
  return ranked.map((entry) => entry.symbol);
}
