import type { Bar, Strategy, Metrics } from "./domain";
const avg = (values: number[]) =>
  values.reduce((a, b) => a + b, 0) / values.length;
export function metrics(bars: Bar[], strategy: Strategy): Metrics | null {
  // CZSC is a monitor slot, never silently evaluated as moving averages.
  if (strategy.type === "czsc" || strategy.type === "dual-breakout")
    return null;
  if (bars.length < strategy.slow + 1) return null;
  const last = bars.at(-1)!,
    previous = bars.at(-2)!,
    fast = avg(bars.slice(-strategy.fast).map((b) => b.close)),
    slow = avg(bars.slice(-strategy.slow).map((b) => b.close)),
    base = avg(bars.slice(-6, -1).map((b) => b.volume)),
    change = (last.close / previous.close - 1) * 100,
    volumeRatio = base > 0 ? last.volume / base : 0;
  return {
    close: last.close,
    change,
    fast,
    slow,
    volumeRatio,
    date: last.date,
    score: (fast / slow - 1) * 100,
    matched:
      fast > slow &&
      last.close > fast &&
      change >= strategy.minChange &&
      change <= strategy.maxChange &&
      volumeRatio >= strategy.minVolumeRatio,
  };
}
