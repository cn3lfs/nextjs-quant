/** Explicitly approximate chart data; never called by the normal import path. */
export function estimateChartVolume(
  symbol: string,
  bar: Buffer,
): number | null {
  if (
    !/^(sh[65]\d{5}|sz(?:00[0-3]|30[01])\d{3}|sz(?:15|16|18)\d{4})$/.test(
      symbol,
    )
  )
    return null;
  if (bar.length !== 32 || bar.readUInt32LE(24) !== 0) return null;
  const open = bar.readFloatLE(4),
    high = bar.readFloatLE(8),
    low = bar.readFloatLE(12),
    close = bar.readFloatLE(16),
    amount = bar.readFloatLE(20);
  if (
    ![open, high, low, close, amount].every(Number.isFinite) ||
    low <= 0 ||
    low > Math.min(open, close) ||
    high < Math.max(open, close) ||
    amount <= 0
  )
    return null;
  const volume = Math.round(amount / ((high + low + close) / 3));
  // Tiny placeholder amounts must not become arbitrary one-share trades.
  return volume >= 1 && volume <= 0xffffffff ? volume : null;
}

export function lc5TimeKey(data: Buffer, offset: number, maxYear: number) {
  const packed = data.readUInt16LE(offset);
  let year = 2004 + (packed >>> 11);
  if (year > maxYear) year -= 32;
  return (
    (year * 10000 + (packed & 2047)) * 1440 + data.readUInt16LE(offset + 2)
  );
}

/** Factor/divisor is calibrated for this timestamp, not a universal asset unit. */
export function estimateCalibratedVolume(
  symbol: string,
  bar: Buffer,
  kind: string,
  factor: number,
): number | null {
  const patterns: Record<string, RegExp> = {
    "b-share": /^(sh900|sz200)\d{3}$/,
    "cash-bond":
      /^(sh(?:009|010|100|110|120|122|126|129|130|143)|sz(?:100|101|111|112|115|123|125|126|128|129))\d{3}$/,
    "historical-repo": /^(sh20[123]|sz131)\d{3}$/,
  };
  if (
    !patterns[kind]?.test(symbol) ||
    bar.length !== 32 ||
    bar.readUInt32LE(24)
  )
    return null;
  const factors =
    kind === "historical-repo"
      ? [1, 10, 100, 1000, 10000, 100000]
      : [0.001, 0.01, 0.1, 1, 10, 100, 1000];
  if (!factors.includes(factor) || (kind === "b-share" && factor !== 1))
    return null;
  const o = bar.readFloatLE(4),
    h = bar.readFloatLE(8),
    l = bar.readFloatLE(12),
    c = bar.readFloatLE(16),
    a = bar.readFloatLE(20);
  if (
    ![o, h, l, c, a].every(Number.isFinite) ||
    l <= 0 ||
    l > Math.min(o, c) ||
    h < Math.max(o, c) ||
    a <= 0
  )
    return null;
  const value = Math.round(
    kind === "historical-repo" ? a / factor : (a / ((h + l + c) / 3)) * factor,
  );
  return value >= 1 && value <= 0xffffffff ? value : null;
}

/** User-authorized visual interpolation; exact snapshot prevents stale plan writes. */
export function visualEstimateFromPlan(
  symbol: string,
  bar: Buffer,
  oldHex: string,
  estimate: number,
  method: string,
  samples: number,
): number | null {
  const minimumSamples: Record<string, number> = {
    "nearby-price-ratio": 5,
    "nearby-amount-ratio": 5,
    "same-clock-volume": 3,
    "nearest-volume": 1,
    "assumed-price-unit": 0,
  };
  if (
    !/^(sh|sz)[a-z0-9]{1,10}$/.test(symbol) ||
    !/^[a-f0-9]{64}$/.test(oldHex) ||
    bar.length !== 32 ||
    bar.toString("hex") !== oldHex ||
    bar.readUInt32LE(24) !== 0 ||
    !Number.isInteger(estimate) ||
    estimate < 1 ||
    estimate > 0xffffffff ||
    !Object.hasOwn(minimumSamples, method) ||
    !Number.isInteger(samples) ||
    samples < minimumSamples[method]!
  )
    return null;
  const o = bar.readFloatLE(4),
    h = bar.readFloatLE(8),
    l = bar.readFloatLE(12),
    c = bar.readFloatLE(16),
    a = bar.readFloatLE(20);
  return [o, h, l, c, a].every(Number.isFinite) &&
    l > 0 &&
    l <= Math.min(o, c) &&
    h >= Math.max(o, c) &&
    a > 0
    ? estimate
    : null;
}
