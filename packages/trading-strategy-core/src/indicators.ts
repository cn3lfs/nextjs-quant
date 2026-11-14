import type { Bar } from "./bars.js";

/** Complete trailing high windows; invalid/suspended bars invalidate the window. */
export function rollingHigh(
  bars: readonly Bar[],
  period: number,
): (number | null)[] {
  if (!Number.isInteger(period) || period < 1)
    throw new Error("最高价窗口无效");
  return bars.map((_, i) => {
    if (i + 1 < period) return null;
    const window = bars.slice(i - period + 1, i + 1);
    if (
      !window.every(
        (b) =>
          [b.open, b.high, b.low, b.close, b.volume].every(
            (v) => Number.isFinite(v) && v > 0,
          ) &&
          b.high >= Math.max(b.open, b.close) &&
          b.low <= Math.min(b.open, b.close),
      )
    )
      return null;
    return Math.max(...window.map((b) => b.high));
  });
}

/** Five to seven candles: large impulse, small opposite bodies contained in
 * its full range, then a large closing break. Thresholds are explicit research
 * definitions, not claimed as unique textbook geometry. */
export function threeMethods(
  bars: readonly Bar[],
  index: number,
  length: 5 | 6 | 7,
  direction: "long" | "short",
) {
  const start = index - length + 1;
  const window = bars.slice(Math.max(0, start - 3), index + 1);
  const valid =
    start >= 3 &&
    window.length === length + 3 &&
    window.every(
      (bar) =>
        Number.isFinite(bar.volume) &&
        bar.volume > 0 &&
        [bar.open, bar.high, bar.low, bar.close].every(
          (x) => Number.isFinite(x) && x > 0,
        ) &&
        bar.high >= Math.max(bar.open, bar.close) &&
        bar.low <= Math.min(bar.open, bar.close) &&
        bar.high > bar.low,
    );
  if (!valid)
    return {
      matched: false,
      reason: "三法形态及背景不足、停牌、一字线或OHLC无效",
      start: null,
      high: null,
      low: null,
      checks: null,
    };
  const first = bars[start]!,
    last = bars[index]!,
    middle = bars.slice(start + 1, index);
  const sign = direction === "long" ? 1 : -1;
  const body = (bar: Bar) => Math.abs(bar.close - bar.open);
  const large = (bar: Bar) =>
    (bar.close - bar.open) * sign > 0 &&
    body(bar) / bar.open >= 0.03 &&
    body(bar) / (bar.high - bar.low) >= 0.6;
  const checks = {
    context: (bars[start - 1]!.close - bars[start - 3]!.close) * sign > 0,
    firstLarge: large(first),
    lastLarge: large(last),
    oppositeSmall: middle.every(
      (bar) =>
        (bar.close - bar.open) * sign < 0 && body(bar) <= body(first) * 0.5,
    ),
    contained: middle.every(
      (bar) => bar.high <= first.high && bar.low >= first.low,
    ),
    break:
      direction === "long" ? last.close > first.high : last.close < first.low,
  };
  return {
    matched: Object.values(checks).every(Boolean),
    reason: null,
    start: first.date,
    high: first.high,
    low: first.low,
    checks,
  };
}

/** M1: unadjusted, ascending bars; output indices match input, with no mutation.
 * Local choices: empty input => []; invalid parameters => RangeError; finite
 * positive closes only. Volume is irrelevant (suspension bars remain included).
 * Keep JS precision internally; rounding belongs only in the manual checklist.
 */
export type IndicatorValue = number | null;
/** Least-squares slope for equally spaced observations x=0..N-1. Missing or
 * non-finite values invalidate the complete window; no filling or rounding.
 * Scaling keeps intermediate sums finite for large but finite observations. */
export function linearSlope(values: readonly IndicatorValue[]): IndicatorValue {
  if (
    values.length < 2 ||
    values.some((v) => v === null || !Number.isFinite(v))
  )
    return null;
  const scale = Math.max(...values.map((v) => Math.abs(v!)));
  if (scale === 0) return 0;
  const middle = (values.length - 1) / 2;
  let numerator = 0,
    denominator = 0;
  values.forEach((v, i) => {
    const x = i - middle;
    numerator += x * (v! / scale);
    denominator += x * x;
  });
  return finite((numerator / denominator) * scale);
}

/** Outward envelopes of least-squares highs/lows. The caller supplies only
 * completed consolidation bars; `next` is their one-step extension. */
export function priceChannel(bars: readonly Bar[]) {
  if (
    bars.length < 2 ||
    bars.some(
      (bar) =>
        !Number.isFinite(bar.volume) ||
        bar.volume <= 0 ||
        ![bar.open, bar.high, bar.low, bar.close].every(
          (x) => Number.isFinite(x) && x > 0,
        ) ||
        bar.high < Math.max(bar.open, bar.close) ||
        bar.low > Math.min(bar.open, bar.close) ||
        bar.high <= bar.low,
    )
  )
    return null;
  const n = bars.length,
    middle = bars.reduce((s, b) => s + b.close / n, 0);
  const fit = (values: number[], upper: boolean) => {
    const slope = linearSlope(values)!;
    const offsets = values.map((value, i) => value - slope * i);
    const intercept = upper ? Math.max(...offsets) : Math.min(...offsets);
    const gaps = values.map((value, i) =>
      Math.abs(intercept + slope * i - value),
    );
    const touches = gaps.flatMap((gap, i) =>
      gap <= middle * 0.001 ? [i] : [],
    );
    return {
      slope,
      intercept,
      next: intercept + slope * n,
      last: intercept + slope * (n - 1),
      error: Math.max(...gaps) / middle,
      touches,
    };
  };
  const upper = fit(
      bars.map((b) => b.high),
      true,
    ),
    lower = fit(
      bars.map((b) => b.low),
      false,
    );
  const startWidth = upper.intercept - lower.intercept,
    endWidth = upper.last - lower.last,
    nextWidth = upper.next - lower.next;
  if (
    ![
      middle,
      upper.slope,
      lower.slope,
      upper.next,
      lower.next,
      startWidth,
      endWidth,
      nextWidth,
      upper.error,
      lower.error,
    ].every(Number.isFinite) ||
    Math.min(upper.next, lower.next, startWidth, endWidth, nextWidth) <= 0
  )
    return null;
  const touchSpread = (touches: number[]) =>
    touches.length >= 2 && touches.at(-1)! - touches[0]! >= n / 2;
  return {
    upper,
    lower,
    startWidth,
    endWidth,
    nextWidth,
    middle,
    wellFormed:
      Math.max(upper.error, lower.error) <= 0.01 &&
      Math.max(startWidth, endWidth) / middle <= 0.2 &&
      touchSpread(upper.touches) &&
      touchSpread(lower.touches),
  };
}
/** Arithmetic-mean ATR: full N true ranges, each requiring the previous close.
 * First bar and invalid OHLC produce null; no synthetic seed or future values.
 * This explicit smoothing choice is the research-management-1 engineering rule.
 */
export function atr(bars: readonly Bar[], n = 14): IndicatorValue[] {
  period(n);
  return maSeries(
    bars.map((bar, i) => {
      const previous = bars[i - 1];
      if (
        !previous ||
        ![bar.high, bar.low, bar.close, previous.close].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        bar.low > bar.high ||
        bar.close < bar.low ||
        bar.close > bar.high
      )
        return null;
      return Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      );
    }),
    n,
  );
}
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
  // Dense finite price histories are the full-market scan hot path. Prove the
  // property once, then retain each window's exact left-to-right arithmetic.
  // Sparse/null/nonfinite formula inputs keep the original per-window semantics.
  let finiteDense = true;
  for (const value of values)
    if (value == null || !Number.isFinite(value)) {
      finiteDense = false;
      break;
    }
  if (finiteDense) {
    const result: IndicatorValue[] = Array(values.length).fill(null);
    for (let i = n - 1; i < values.length; i++) {
      let sum = 0;
      for (let at = i + 1 - n; at <= i; at++) sum += values[at]!;
      result[i] = finite(sum / n);
    }
    return result;
  }
  return values.map((_, i) => {
    if (i + 1 < n) return null;
    // Preserve each window's left-to-right addition (including overflow and
    // cancellation). A rolling sum would change rounding at CROSS boundaries.
    let sum = 0;
    for (let at = i + 1 - n; at <= i; at++) {
      const value = values[at];
      if (value === undefined && !(at in values)) continue;
      if (value == null || !Number.isFinite(value)) return null;
      sum += value;
    }
    return finite(sum / n);
  });
}

/** Volume windows count trading observations: zero-volume suspension rows
 * are omitted, invalid volumes remain null observations. Output stays aligned.
 * prior=true excludes today's volume from the denominator. */
export function volumeMa(
  bars: readonly Bar[],
  n = 5,
  prior = false,
): IndicatorValue[] {
  period(n);
  const observations: IndicatorValue[] = [];
  const indices = bars.map((bar) => {
    if (bar.volume === 0) return null;
    observations.push(
      Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : null,
    );
    return observations.length - 1;
  });
  const values = maSeries(observations, n);
  return indices.map((index) =>
    index == null ? null : (values[index - (prior ? 1 : 0)] ?? null),
  );
}
/** Prior N effective volume observations; suspension is omitted, invalid
 * observations invalidate the whole window instead of silently disappearing. */
export function priorVolumeRange(bars: readonly Bar[], n = 60) {
  period(n);
  const observations: IndicatorValue[] = [];
  return bars.map((bar) => {
    const window = observations.slice(-n);
    const valid = window.length === n && window.every((v) => v !== null);
    const result =
      bar.volume === 0 || !valid
        ? { low: null, high: null }
        : {
            low: Math.min(...(window as number[])),
            high: Math.max(...(window as number[])),
          };
    if (bar.volume !== 0)
      observations.push(
        Number.isFinite(bar.volume) && bar.volume > 0 ? bar.volume : null,
      );
    return result;
  });
}

/** OBV uses close direction and today's volume. Zero is an arbitrary origin;
 * invalid/zero-volume observations break the segment, so downstream windows
 * must not compare across the missing row. No interpolation or volume guess. */
export function obv(bars: readonly Bar[]): IndicatorValue[] {
  let previous: number | null = null,
    total = 0;
  return bars.map((bar) => {
    if (
      closeOf(bar) === null ||
      !Number.isFinite(bar.volume) ||
      bar.volume <= 0
    ) {
      previous = null;
      total = 0;
      return null;
    }
    const next =
      previous === null
        ? 0
        : finite(total + Math.sign(bar.close - previous) * bar.volume);
    if (next === null) {
      previous = null;
      total = 0;
      return null;
    }
    previous = bar.close;
    total = next;
    return total;
  });
}

export type ConfirmedExtremum = {
  index: number;
  date: string;
  confirmedAt: string;
  kind: "high" | "low";
  price: number;
};
/** Exact extraction of the existing VCP diagnostic's strict 3/3 extrema.
 * Ties are not extrema; outside bars that are both kinds are quarantined.
 * Input validation and suspension policy remain the caller's responsibility. */
export function confirmedExtrema(bars: readonly Bar[]) {
  const extrema: ConfirmedExtremum[] = [],
    ambiguousDates: string[] = [],
    ambiguousIndices: number[] = [];
  for (let index = 3; index < bars.length - 3; index++) {
    const bar = bars[index]!;
    const peers = bars.slice(index - 3, index + 4).filter((_, i) => i !== 3);
    const high = peers.every((b) => bar.high > b.high),
      low = peers.every((b) => bar.low < b.low);
    if (high && low) {
      ambiguousDates.push(bar.date);
      ambiguousIndices.push(index);
      continue;
    }
    if (high || low)
      extrema.push({
        index,
        date: bar.date,
        confirmedAt: bars[index + 3]!.date,
        kind: high ? "high" : "low",
        price: high ? bar.high : bar.low,
      });
  }
  return { extrema, ambiguousDates, ambiguousIndices };
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

/** CCI: typical price and mean absolute deviation, not standard deviation. */
export function cci(bars: readonly Bar[], n = 20): IndicatorValue[] {
  period(n, 2);
  const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
  return maSeries(typical, n).map((mean, i) => {
    if (mean === null) return null;
    const deviation =
      typical
        .slice(i + 1 - n, i + 1)
        .reduce((sum, v) => sum + Math.abs(v - mean), 0) / n;
    return deviation === 0 ? null : (typical[i]! - mean) / (0.015 * deviation);
  });
}

/** MFI uses price-directed raw volume; a flat window has no defined ratio. */
export function mfi(bars: readonly Bar[], n = 14): IndicatorValue[] {
  period(n);
  const typical = bars.map((b) => (b.high + b.low + b.close) / 3);
  return bars.map((_, i) => {
    if (i < n) return null;
    let positive = 0,
      negative = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = typical[j]! * bars[j]!.volume;
      if (typical[j]! > typical[j - 1]!) positive += flow;
      if (typical[j]! < typical[j - 1]!) negative += flow;
    }
    return positive + negative === 0
      ? null
      : (100 * positive) / (positive + negative);
  });
}

export function williamsR(bars: readonly Bar[], n = 14): IndicatorValue[] {
  period(n);
  return bars.map((b, i) => {
    if (i + 1 < n) return null;
    const window = bars.slice(i + 1 - n, i + 1);
    const high = Math.max(...window.map((v) => v.high));
    const low = Math.min(...window.map((v) => v.low));
    return high === low ? null : (-100 * (high - b.close)) / (high - low);
  });
}

export function chaikinMoneyFlow(
  bars: readonly Bar[],
  n = 20,
): IndicatorValue[] {
  period(n);
  const flows = bars.map((b) =>
    b.high === b.low
      ? 0
      : ((2 * b.close - b.high - b.low) / (b.high - b.low)) * b.volume,
  );
  const flowMean = maSeries(flows, n),
    volumeMean = volumeMa(bars, n);
  return flowMean.map((v, i) =>
    v === null || volumeMean[i] === null || volumeMean[i] === 0
      ? null
      : v / volumeMean[i]!,
  );
}

/** Wilder DMI: full N-value arithmetic seeds, then alpha=1/N smoothing. */
export function dmi(bars: readonly Bar[], n = 14) {
  period(n, 2);
  const tr: IndicatorValue[] = [],
    plus: IndicatorValue[] = [],
    minus: IndicatorValue[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!,
      p = bars[i - 1];
    const up = p ? b.high - p.high : 0,
      down = p ? p.low - b.low : 0;
    tr.push(
      p
        ? Math.max(
            b.high - b.low,
            Math.abs(b.high - p.close),
            Math.abs(b.low - p.close),
          )
        : null,
    );
    plus.push(p ? (up > down && up > 0 ? up : 0) : null);
    minus.push(p ? (down > up && down > 0 ? down : 0) : null);
  }
  function wilder(values: IndicatorValue[]) {
    let value: IndicatorValue = null;
    return values.map((v, i) => {
      if (v === null) return null;
      if (value === null) {
        const window = values.slice(Math.max(0, i + 1 - n), i + 1);
        if (window.length < n || window.some((x) => x === null)) return null;
        value = window.reduce<number>((sum, x) => sum + x!, 0) / n;
      } else value = (value * (n - 1) + v) / n;
      return value;
    });
  }
  const ranges = wilder(tr),
    positives = wilder(plus),
    negatives = wilder(minus);
  const pdi = ranges.map((v, i) =>
    v === null || v === 0 ? null : (100 * positives[i]!) / v,
  );
  const mdi = ranges.map((v, i) =>
    v === null || v === 0 ? null : (100 * negatives[i]!) / v,
  );
  const dx = pdi.map((v, i) =>
    v === null || mdi[i] === null || v + mdi[i]! === 0
      ? null
      : (100 * Math.abs(v - mdi[i]!)) / (v + mdi[i]!),
  );
  const adx = wilder(dx);
  return bars.map((_, i) => ({ plus: pdi[i]!, minus: mdi[i]!, adx: adx[i]! }));
}

/** Explicit arithmetic ATR variant; final bands carry only past state. */
export function supertrend(bars: readonly Bar[], n = 10, multiplier = 3) {
  period(n);
  if (!Number.isFinite(multiplier) || multiplier <= 0)
    throw new RangeError("Invalid multiplier");
  const ranges = atr(bars, n);
  let upper: number | null = null,
    lower: number | null = null,
    bullish = true;
  return bars.map((b, i) => {
    if (ranges[i] === null) return null;
    const basicUpper = (b.high + b.low) / 2 + multiplier * ranges[i]!;
    const basicLower = (b.high + b.low) / 2 - multiplier * ranges[i]!;
    if (upper === null || lower === null) {
      upper = basicUpper;
      lower = basicLower;
    } else {
      upper =
        basicUpper < upper || bars[i - 1]!.close > upper ? basicUpper : upper;
      lower =
        basicLower > lower || bars[i - 1]!.close < lower ? basicLower : lower;
      bullish = bullish ? b.close >= lower : b.close > upper;
    }
    return { bullish, value: bullish ? lower : upper };
  });
}

/** Causal parabolic SAR with two-prior-bar clamps and 0.02/0.20 defaults. */
export function parabolicSar(bars: readonly Bar[], step = 0.02, maximum = 0.2) {
  if (!(step > 0 && maximum >= step && maximum <= 1))
    throw new RangeError("Invalid SAR acceleration");
  let bullish = true,
    sar = 0,
    extreme = 0,
    acceleration = step;
  return bars.map((b, i) => {
    if (i === 0) return null;
    if (i === 1) {
      bullish = b.close >= bars[0]!.close;
      sar = bullish
        ? Math.min(b.low, bars[0]!.low)
        : Math.max(b.high, bars[0]!.high);
      extreme = bullish
        ? Math.max(b.high, bars[0]!.high)
        : Math.min(b.low, bars[0]!.low);
    } else {
      const projected = sar + acceleration * (extreme - sar);
      sar = bullish
        ? Math.min(projected, bars[i - 1]!.low, bars[i - 2]!.low)
        : Math.max(projected, bars[i - 1]!.high, bars[i - 2]!.high);
      if ((bullish && b.low < sar) || (!bullish && b.high > sar)) {
        bullish = !bullish;
        sar = extreme;
        extreme = bullish ? b.high : b.low;
        acceleration = step;
      } else if (
        (bullish && b.high > extreme) ||
        (!bullish && b.low < extreme)
      ) {
        extreme = bullish ? b.high : b.low;
        acceleration = Math.min(maximum, acceleration + step);
      }
    }
    return { bullish, value: sar };
  });
}

/** Cloud at t uses spans calculated at t-26. No future Chikou comparisons. */
export function ichimoku(bars: readonly Bar[]) {
  function midpoint(i: number, n: number) {
    if (i + 1 < n) return null;
    const window = bars.slice(i + 1 - n, i + 1);
    return (
      (Math.max(...window.map((b) => b.high)) +
        Math.min(...window.map((b) => b.low))) /
      2
    );
  }
  const conversion = bars.map((_, i) => midpoint(i, 9));
  const base = bars.map((_, i) => midpoint(i, 26));
  return bars.map((_, i) => {
    const j = i - 26,
      spanB = j >= 0 ? midpoint(j, 52) : null;
    const spanA =
      j >= 0 && conversion[j] !== null && base[j] !== null
        ? (conversion[j]! + base[j]!) / 2
        : null;
    return {
      conversion: conversion[i]!,
      base: base[i]!,
      upper: spanA === null || spanB === null ? null : Math.max(spanA, spanB),
      lower: spanA === null || spanB === null ? null : Math.min(spanA, spanB),
    };
  });
}

// Only five named reversal patterns. Context is a three-session directional
// move before the pattern, not a guessed swing endpoint. Star gaps refer to
// real bodies; confirmation closes past the first body's midpoint.
export function candlePatterns(
  bars: readonly Bar[],
  i: number,
  direction: "long" | "short",
  extended = false,
): string[] {
  const body = (bar: Bar) => Math.abs(bar.close - bar.open);
  const c = bars[i],
    b = bars[i - 1],
    a = bars[i - 2];
  if (!c || !b || !a || i < 5) return [];
  const sign = direction === "long" ? 1 : -1;
  const context = (start: number) =>
    (bars[start - 1]!.close - bars[start - 3]!.close) * sign < 0;
  const found: string[] = [];
  if (
    direction === "long" &&
    context(i) &&
    body(c) > 0 &&
    Math.min(c.open, c.close) - c.low >= body(c) * 2 &&
    c.high - Math.max(c.open, c.close) <= body(c) * 0.25
  )
    found.push("锤子线");
  if (
    context(i - 1) &&
    (c.close - c.open) * sign > 0 &&
    (b.close - b.open) * sign < 0 &&
    (c.open - b.close) * sign <= 0 &&
    (c.close - b.open) * sign >= 0 &&
    body(c) > body(b)
  )
    found.push(direction === "long" ? "看涨吞没" : "看跌吞没");
  const gap =
    direction === "long"
      ? Math.max(b.open, b.close) < Math.min(a.open, a.close)
      : Math.min(b.open, b.close) > Math.max(a.open, a.close);
  if (
    context(i - 2) &&
    (a.close - a.open) * sign < 0 &&
    body(b) <= body(a) * 0.3 &&
    gap &&
    (c.close - c.open) * sign > 0 &&
    (c.close - (a.open + a.close) / 2) * sign > 0
  )
    found.push(direction === "long" ? "启明星" : "黄昏之星");
  if (extended) {
    const doji = (bar: Bar) =>
      bar.high > bar.low && body(bar) <= (bar.high - bar.low) * 0.1;
    if (
      direction === "short" &&
      context(i) &&
      body(c) > 0 &&
      c.high - Math.max(c.open, c.close) >= body(c) * 2 &&
      Math.min(c.open, c.close) - c.low <= body(c) * 0.25
    )
      found.push("射击之星");
    if (context(i) && doji(c))
      found.push(direction === "long" ? "底部十字星" : "顶部十字星");
    if (direction === "long" && found.includes("启明星") && doji(b))
      found.push("早晨之星");
    if (
      direction === "short" &&
      context(i - 1) &&
      b.close > b.open &&
      c.close < c.open &&
      c.open > b.high &&
      c.close < (b.open + b.close) / 2 &&
      c.close > b.open
    )
      found.push("乌云盖顶");
  }
  return found;
}
