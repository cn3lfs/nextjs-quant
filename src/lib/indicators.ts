import type { Bar } from "./domain";

/** M1: unadjusted, ascending bars; output indices match input, with no mutation.
 * Local choices: empty input => []; invalid parameters => RangeError; finite
 * positive closes only. Volume is irrelevant (suspension bars remain included).
 * Keep JS precision internally; rounding belongs only in the manual checklist.
 */
export type IndicatorValue = number | null;
const finite = (x: number): IndicatorValue => (Number.isFinite(x) ? x : null);
const closeOf = (bar: Bar): IndicatorValue =>
  bar.close > 0 ? finite(bar.close) : null;
function period(n: number, minimum = 1) {
  if (!Number.isSafeInteger(n) || n < minimum)
    throw new RangeError(`Period must be an integer >= ${minimum}`);
}

// docs/roadmap.md §3.1 EMA/SMA; §3.4: skip invalid samples without resetting state.
// Return validity separately through callers: held outputs must not feed downstream
// smoothers on an invalid day, otherwise their state would still advance.
function smooth(
  values: IndicatorValue[],
  n: number,
  m: number,
): IndicatorValue[] {
  let previous: IndicatorValue = null;
  return values.map((x) => {
    if (x !== null) {
      const next =
        previous === null ? x : finite((m * x + (n - m) * previous) / n);
      if (next !== null) previous = next;
    }
    return previous;
  });
}

/** MA: docs/roadmap.md §3.1 MA(C,N), §3.2 full windows only. */
export function ma(bars: readonly Bar[], n = 20): IndicatorValue[] {
  period(n);
  return maSeries(bars.map(closeOf), n);
}

/** Shared sequence primitives for formulas and chart wrappers. Unlike prices,
 * formula inputs may be zero or negative. M1 null/window/state rules are retained.
 * Sources: tdx-doc 引用函数 MA/EMA/SMA; 统计函数 STD; roadmap §3.1–3.4.
 */
export function maSeries(
  values: readonly IndicatorValue[],
  n: number,
): IndicatorValue[] {
  period(n);
  return values.map((_, i) => {
    if (i + 1 < n) return null;
    const window = values.slice(i + 1 - n, i + 1);
    if (window.some((v) => v === null || !Number.isFinite(v))) return null;
    return finite((window as number[]).reduce((sum, v) => sum + v, 0) / n);
  });
}
export function emaSeries(values: readonly IndicatorValue[], n: number) {
  period(n);
  return smooth(
    values.map((v) => (v === null ? null : finite(v))),
    n + 1,
    2,
  );
}
export function smaSeries(
  values: readonly IndicatorValue[],
  n: number,
  m: number,
) {
  period(n);
  period(m);
  if (m > n) throw new RangeError("SMA requires M <= N");
  return smooth(
    values.map((v) => (v === null ? null : finite(v))),
    n,
    m,
  );
}
export function stdSeries(
  values: readonly IndicatorValue[],
  n: number,
): IndicatorValue[] {
  period(n, 2);
  return maSeries(values, n).map((mid, i) => {
    if (mid === null) return null;
    const variance =
      values
        .slice(i + 1 - n, i + 1)
        .reduce<number>((sum, v) => sum + (v! - mid) ** 2, 0) /
      (n - 1);
    return finite(Math.sqrt(variance));
  });
}

/** EMA: docs/roadmap.md §3.1 EMA(X,N), seeded by first valid close. */
export function ema(bars: readonly Bar[], n = 20): IndicatorValue[] {
  period(n);
  return emaSeries(bars.map(closeOf), n);
}

/** MACD(12,26,9): docs/roadmap.md §3.1; histogram includes the factor 2. */
export function macd(
  bars: readonly Bar[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
) {
  period(fastPeriod);
  period(slowPeriod);
  period(signalPeriod);
  const fast = ema(bars, fastPeriod),
    slow = ema(bars, slowPeriod);
  const dif = bars.map((_, i) =>
    fast[i] === null || slow[i] === null ? null : finite(fast[i]! - slow[i]!),
  );
  const dea = smooth(
    dif.map((v, i) => (closeOf(bars[i]!) === null ? null : v)),
    signalPeriod + 1,
    2,
  );
  return dif.map((v, i) => ({
    dif: v,
    dea: dea[i]!,
    macd: v === null || dea[i] === null ? null : finite(2 * (v - dea[i]!)),
  }));
}

/** KDJ(9,3,3): docs/roadmap.md §3.1–§3.4. No artificial 50 seed.
 * Invalid H/L/C in a window invalidates RSV; a zero range holds BOTH K and D.
 */
export function kdj(bars: readonly Bar[], n = 9, kPeriod = 3, dPeriod = 3) {
  period(n);
  period(kPeriod);
  period(dPeriod);
  const rsv = bars.map((bar, i): IndicatorValue => {
    if (i < n - 1) return null;
    const window = bars.slice(i - n + 1, i + 1);
    if (
      window.some(
        (b) =>
          closeOf(b) === null ||
          !Number.isFinite(b.high) ||
          !Number.isFinite(b.low) ||
          b.low <= 0 ||
          b.high < b.close ||
          b.low > b.close,
      )
    )
      return null;
    const high = Math.max(...window.map((b) => b.high)),
      low = Math.min(...window.map((b) => b.low));
    return high === low
      ? null
      : finite(((bar.close - low) / (high - low)) * 100);
  });
  const k = smooth(rsv, kPeriod, 1);
  const d = smooth(
    k.map((v, i) => (rsv[i] === null ? null : v)),
    dPeriod,
    1,
  );
  return rsv.map((v, i) => ({
    rsv: v,
    k: k[i]!,
    d: d[i]!,
    j: k[i] === null || d[i] === null ? null : finite(3 * k[i]! - 2 * d[i]!),
  }));
}

/** RSI(6,12,24): docs/roadmap.md §3.1 SMA(X,N,1) is Wilder smoothing.
 * Local choices: REF(C,1) is unavailable at index 0 => null, not zero change.
 * Flat 0/0 => null; valid zero deltas still update both smoothers. Invalid close
 * invalidates both adjacent deltas (REF means previous bar, not previous valid bar).
 */
export function rsi(
  bars: readonly Bar[],
  periods: readonly [number, number, number] = [6, 12, 24],
) {
  periods.forEach((n) => period(n));
  const delta = bars.map((bar, i): IndicatorValue => {
    const current = closeOf(bar),
      previous = i ? closeOf(bars[i - 1]!) : null;
    return current === null || previous === null
      ? null
      : finite(current - previous);
  });
  const lines = periods.map((n) => {
    const up = smooth(
      delta.map((v) => (v === null ? null : Math.max(v, 0))),
      n,
      1,
    );
    const absolute = smooth(
      delta.map((v) => (v === null ? null : Math.abs(v))),
      n,
      1,
    );
    return up.map((v, i) =>
      v === null || absolute[i] === null || absolute[i] === 0
        ? null
        : finite((v / absolute[i]!) * 100),
    );
  });
  return bars.map((_, i) => ({
    rsi6: lines[0]![i]!,
    rsi12: lines[1]![i]!,
    rsi24: lines[2]![i]!,
  }));
}

/** BOLL: docs/roadmap.md §3.1 BOLL(20,2), sample STD denominator N-1.
 * Local choice: N >= 2, finite nonnegative multiplier; no intermediate rounding.
 */
export function boll(bars: readonly Bar[], n = 20, multiplier = 2) {
  period(n, 2);
  if (!Number.isFinite(multiplier) || multiplier < 0)
    throw new RangeError("Invalid BOLL multiplier");
  const std = stdSeries(bars.map(closeOf), n);
  return ma(bars, n).map((mid, i) => {
    if (mid === null) return { mid: null, upper: null, lower: null };
    const width = multiplier * std[i]!;
    return { mid, upper: finite(mid + width), lower: finite(mid - width) };
  });
}
