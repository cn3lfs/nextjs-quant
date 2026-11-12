/** Completed, continuous spot candles only; no execution or exchange dependencies. */
export function cryptoDualMa(closes: number[], fast: number, slow: number) {
  if (
    !Number.isInteger(fast) ||
    !Number.isInteger(slow) ||
    fast < 1 ||
    slow <= fast
  )
    throw new Error("均线参数须满足 1 ≤ 短周期 < 长周期");
  if (closes.some((x) => !Number.isFinite(x) || x <= 0))
    throw new Error("无效收盘价");
  if (closes.length < slow + 1) return null;
  const mean = (end: number, size: number) =>
    closes.slice(end - size, end).reduce((a, b) => a + b, 0) / size;
  const n = closes.length;
  const short = mean(n, fast),
    long = mean(n, slow);
  const previousShort = mean(n - 1, fast),
    previousLong = mean(n - 1, slow);
  const signal =
    previousShort <= previousLong && short > long
      ? "BUY"
      : previousShort >= previousLong && short < long
        ? "SELL"
        : "HOLD";
  return { short, long, previousShort, previousLong, signal } as const;
}
