/**
 * The list a chart was opened from (screening candidates, rankings …). As in
 * TDX, PageUp/PageDown in the chart step through it in its original order.
 */
export type BrowseList = {
  label: string;
  symbols: readonly string[];
  index: number;
};

/** Neighbour in the list; null at either end (no wrap-around). */
export function stepBrowse(list: BrowseList, delta: -1 | 1): BrowseList | null {
  const index = list.index + delta;
  return index >= 0 && index < list.symbols.length ? { ...list, index } : null;
}
