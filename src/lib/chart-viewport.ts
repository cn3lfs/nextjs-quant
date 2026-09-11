import type { Bar } from "./domain";
type Range = { from: number; to: number };
const views = new Map<
  string,
  { date: string; offset: number; width: number }
>();
export function rememberChartRange(
  key: string,
  bars: Bar[],
  start: number,
  range: Range | null,
) {
  if (!range || !bars.length) return;
  const absolute = start + range.from;
  const anchor = Math.max(0, Math.min(bars.length - 1, Math.floor(absolute)));
  views.set(key, {
    date: bars[anchor]!.date,
    offset: absolute - anchor,
    width: range.to - range.from,
  });
  if (views.size > 200) views.delete(views.keys().next().value!);
}
export function restoreChartRange(key: string, bars: Bar[]) {
  const saved = views.get(key);
  if (!saved) return null;
  const index = bars.findIndex((b) => b.date === saved.date);
  if (index < 0) return null;
  const start = Math.max(0, index - 180);
  const from = index - start + saved.offset;
  return { start, range: { from, to: from + saved.width } };
}
