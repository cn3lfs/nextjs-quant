export interface CzscInput {
  anchor?: 1 | 2 | 3;
  dates?: string[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

// Reject overflow rather than silently passing infinities to native code.
export function toFloat32(values: readonly number[]): Float32Array {
  const result = Float32Array.from(values);
  if (
    values.some((v) => !Number.isFinite(v)) ||
    result.some((v) => !Number.isFinite(v))
  )
    throw new RangeError("CZSC requires finite float32 input");
  return result;
}

export function czscInput(input: CzscInput) {
  const high = toFloat32(input.high),
    low = toFloat32(input.low),
    close = toFloat32(input.close),
    volume = toFloat32(input.volume);
  if ([low, close, volume].some((a) => a.length !== high.length))
    throw new RangeError("CZSC input lengths differ");
  if (
    high.some(
      (v, i) =>
        v < low[i]! || close[i]! > v || close[i]! < low[i]! || volume[i]! < 0,
    )
  )
    throw new RangeError("Invalid CZSC OHLCV");
  return { high, low, close, volume };
}
