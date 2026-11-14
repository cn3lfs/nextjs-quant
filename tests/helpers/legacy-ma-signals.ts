import { ma } from "trading-strategy-core/indicators";
import type { Bar } from "trading-strategy-core/bars";
import type { SignalSeries } from "trading-strategies";
export const maBaselineId = "ma-cross-baseline-v1" as const;
/** Shared indicator core is the only MA implementation. */
export function maBaselineSignals(bars: readonly Bar[]) {
  const fast = ma(bars, 5),
    slow = ma(bars, 20),
    signals = new Int8Array(bars.length);
  for (let i = 20; i < bars.length; i++) {
    if (
      fast[i - 1] == null ||
      slow[i - 1] == null ||
      fast[i] == null ||
      slow[i] == null
    )
      continue;
    if (fast[i - 1]! <= slow[i - 1]! && fast[i]! > slow[i]!) signals[i] = 1;
    else if (fast[i - 1]! >= slow[i - 1]! && fast[i]! < slow[i]!)
      signals[i] = -1;
  }
  return signals;
}
export function maCrossStrategy(bars: readonly Bar[]): SignalSeries {
  return { id: maBaselineId, warmupBars: 20, values: maBaselineSignals(bars) };
}
