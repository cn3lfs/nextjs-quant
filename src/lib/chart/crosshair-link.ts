import type { Bar } from "../domain";
import { isMinutePeriod, type ChartPeriod } from "./chart-view";

/**
 * The instant a bar ends: minute bars carry their own +08:00 timestamp; day,
 * week and month bars end at the 15:00 close of their dated trading day.
 */
export function barInstant(date: string, period: ChartPeriod) {
  return isMinutePeriod(period)
    ? Date.parse(date)
    : Date.parse(`${date.slice(0, 10)}T15:00:00+08:00`);
}

const day = (instant: number) =>
  new Date(instant + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * Index of the bar that contains `instant` (the first bar ending at or after
 * it), or null when this chart has no such bar. Minute and day charts only
 * match within the same trading day, so a 30-minute chart that starts later
 * never points at an unrelated day; week/month bars match the period that
 * contains the instant.
 */
export function linkedIndex(
  bars: readonly Bar[],
  period: ChartPeriod,
  instant: number,
): number | null {
  let lo = 0,
    hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (barInstant(bars[mid]!.date, period) < instant) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= bars.length) return null;
  if (period === "week" || period === "month") {
    const previous = lo > 0 ? barInstant(bars[lo - 1]!.date, period) : null;
    const span = period === "week" ? 7 : 31;
    const end = barInstant(bars[lo]!.date, period);
    return previous !== null || end - instant < span * 86400_000 ? lo : null;
  }
  return day(barInstant(bars[lo]!.date, period)) === day(instant) ? lo : null;
}

type Listener = (from: string, instant: number | null) => void;

/** Crosshair position shared by charts of one symbol (TDX 多周期同列). */
export function createCrosshairLink() {
  const listeners = new Set<Listener>();
  return {
    publish(from: string, instant: number | null) {
      for (const listener of listeners) listener(from, instant);
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type CrosshairLink = ReturnType<typeof createCrosshairLink>;

type Anchor = { date: string; price: number; offset?: number };

/**
 * A drawing from another period placed on this chart's bars: each anchor
 * moves to the bar containing its instant (sub-bar offsets are dropped, they
 * are in the other period's bar widths). Null when an anchor falls outside
 * this chart's data, so nothing is drawn at an unrelated date.
 */
export function remapDrawing<
  D extends { a: Anchor; b: Anchor; c?: Anchor | undefined },
>(
  drawing: D,
  origin: ChartPeriod,
  bars: readonly Bar[],
  period: ChartPeriod,
): D | null {
  const move = (anchor: Anchor): Anchor | null => {
    const index = linkedIndex(bars, period, barInstant(anchor.date, origin));
    return index === null
      ? null
      : { date: bars[index]!.date, price: anchor.price };
  };
  const a = move(drawing.a),
    b = move(drawing.b),
    c = drawing.c ? move(drawing.c) : undefined;
  if (!a || !b || c === null) return null;
  return { ...drawing, a, b, ...(c ? { c } : {}) };
}
