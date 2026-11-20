import type { Bar } from "trading-strategy-core/bars";

export function candle(
  index: number,
  close: number,
  fields: Partial<Pick<Bar, "open" | "high" | "low" | "volume">> = {},
): Bar {
  const open = fields.open ?? close;
  return {
    date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
    open,
    high: fields.high ?? Math.max(open, close) + 0.25,
    low: fields.low ?? Math.min(open, close) - 0.25,
    close,
    volume: fields.volume ?? 100,
    amount: close * (fields.volume ?? 100),
  };
}

// Reflection swaps support and resistance while preserving ranges and bodies.
export function reflectBars(bars: readonly Bar[], sum: number): Bar[] {
  return bars.map((bar) => ({
    ...bar,
    open: sum - bar.open,
    high: sum - bar.low,
    low: sum - bar.high,
    close: sum - bar.close,
    amount: (sum - bar.close) * bar.volume,
  }));
}
