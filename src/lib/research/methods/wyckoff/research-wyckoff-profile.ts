import type { Bar } from "../../../domain";

/** Uniform allocation by overlap length. This is NOT observed volume-at-price. */
export function wyckoffDailyProfile(
  bars: readonly Bar[],
  low: number,
  high: number,
) {
  if (
    bars.length < 20 ||
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    low <= 0 ||
    high <= low ||
    bars.some(
      (b) =>
        ![b.low, b.high, b.volume].every((v) => Number.isFinite(v) && v > 0) ||
        b.high <= b.low ||
        b.low < low ||
        b.high > high,
    )
  )
    return {
      status: "missing" as const,
      reason: "日线估算需至少20根全部位于冻结TR内的有效价量",
      bins: [],
      poc: null,
      hvn: [],
      lvn: [],
    };
  const step = (high - low) / 12;
  const bins = Array.from({ length: 12 }, (_, i) => ({
    low: low + i * step,
    high: i === 11 ? high : low + (i + 1) * step,
    volume: 0,
  }));
  for (const b of bars)
    for (const bin of bins)
      bin.volume +=
        (b.volume *
          Math.max(0, Math.min(b.high, bin.high) - Math.max(b.low, bin.low))) /
        (b.high - b.low);
  const order = bins
    .map((b, index) => ({ index, volume: b.volume }))
    .sort((a, b) => b.volume - a.volume || a.index - b.index);
  return {
    status: "daily-uniform-estimate" as const,
    reason: null,
    bins,
    poc: order[0]!.index,
    hvn: order.slice(0, 3).map((b) => b.index),
    lvn: order.slice(-3).map((b) => b.index),
    totalVolume: bins.reduce((s, b) => s + b.volume, 0),
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
  };
}
