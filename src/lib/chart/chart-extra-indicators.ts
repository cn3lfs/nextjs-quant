import type { Bar } from "../domain";
import {
  ema,
  maSeries,
  obv,
  type IndicatorValue,
} from "../indicators";

// Broker-standard (TDX) formulas for chart-only indicators. Null inputs or
// incomplete windows stay null; no filling or rounding.
const finite = (v: number): IndicatorValue => (Number.isFinite(v) ? v : null);

function windowOf<T>(values: readonly T[], i: number, n: number) {
  return i + 1 < n ? null : values.slice(i + 1 - n, i + 1);
}

/** WR(N) = 100 × (HHV(H,N) − C) / (HHV(H,N) − LLV(L,N)). */
export function williams(bars: readonly Bar[], n: number): IndicatorValue[] {
  return bars.map((bar, i) => {
    const w = windowOf(bars, i, n);
    if (!w) return null;
    const high = Math.max(...w.map((b) => b.high)),
      low = Math.min(...w.map((b) => b.low));
    return high === low ? null : finite((100 * (high - bar.close)) / (high - low));
  });
}

/** BIAS(N) = (C − MA(C,N)) / MA(C,N) × 100. */
export function bias(bars: readonly Bar[], n: number): IndicatorValue[] {
  const average = maSeries(
    bars.map((b) => b.close),
    n,
  );
  return bars.map((bar, i) => {
    const m = average[i];
    return m == null || m === 0 ? null : finite(((bar.close - m) / m) * 100);
  });
}

/** CCI(N) = (TYP − MA(TYP,N)) / (0.015 × AVEDEV(TYP,N)), TYP=(H+L+C)/3. */
export function cci(bars: readonly Bar[], n: number): IndicatorValue[] {
  const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
  return typical.map((value, i) => {
    const w = windowOf(typical, i, n);
    if (!w) return null;
    const mean = w.reduce((s, v) => s + v, 0) / n,
      deviation = w.reduce((s, v) => s + Math.abs(v - mean), 0) / n;
    return deviation === 0 ? null : finite((value - mean) / (0.015 * deviation));
  });
}

export { ema, obv };
