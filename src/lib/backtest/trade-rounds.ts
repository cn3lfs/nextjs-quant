import type { Bar, Trade } from "../domain";

/**
 * One buy → sell round trip of a single-position backtest, with the extremes
 * it went through (TradingView's run-up / drawdown per trade).
 */
export type TradeRound = {
  entryDate: string;
  /** Null while the position is still open at the end of the data. */
  exitDate: string | null;
  entryPrice: number;
  exitPrice: number | null;
  shares: number;
  /** Bars held, entry and exit day included. */
  bars: number;
  /** Net of both fees: sell proceeds / buy cost − 1; null while open. */
  netReturn: number | null;
  /** Highest high over the round ÷ entry price − 1 (maximum favourable excursion). */
  mfe: number | null;
  /** Lowest low over the round ÷ entry price − 1 (maximum adverse excursion). */
  mae: number | null;
};

/**
 * Pairs a backtest's chronological trades into rounds and measures MFE/MAE on
 * the bars the backtest used (same prices, same adjustment). A round that is
 * still open runs to the last bar and has no exit or return.
 */
export function tradeRounds(
  trades: readonly Trade[],
  bars: readonly Bar[],
): TradeRound[] {
  const index = new Map(bars.map((bar, i) => [bar.date.slice(0, 10), i]));
  const rounds: TradeRound[] = [];
  let open: Trade | null = null;
  const close = (buy: Trade, sell: Trade | null) => {
    const from = index.get(buy.date.slice(0, 10));
    const to = sell ? index.get(sell.date.slice(0, 10)) : bars.length - 1;
    let high = -Infinity,
      low = Infinity;
    if (from !== undefined && to !== undefined)
      for (let i = from; i <= to; i++) {
        high = Math.max(high, bars[i]!.high);
        low = Math.min(low, bars[i]!.low);
      }
    const known = from !== undefined && to !== undefined && buy.price > 0;
    const cost = buy.price * buy.shares + buy.fee;
    rounds.push({
      entryDate: buy.date,
      exitDate: sell?.date ?? null,
      entryPrice: buy.price,
      exitPrice: sell?.price ?? null,
      shares: buy.shares,
      bars: from !== undefined && to !== undefined ? to - from + 1 : 0,
      netReturn:
        sell && cost > 0
          ? (sell.price * sell.shares - sell.fee) / cost - 1
          : null,
      mfe: known && Number.isFinite(high) ? high / buy.price - 1 : null,
      mae: known && Number.isFinite(low) ? low / buy.price - 1 : null,
    });
  };
  for (const trade of trades) {
    if (trade.side === "buy") {
      if (!open) open = trade;
    } else if (open) {
      close(open, trade);
      open = null;
    }
  }
  if (open) close(open, null);
  return rounds;
}

export type PeriodReturn = {
  period: string;
  strategy: number | null;
  benchmark: number | null;
};

/**
 * Month/quarter/year returns of the strategy and buy-and-hold equity curves:
 * each period's last value over the previous period's last value (the first
 * period starts from the curve's first value).
 */
export function periodReturns(
  equity: readonly { date: string; value: number }[],
  benchmark: readonly { date: string; value: number }[] | undefined,
  unit: "month" | "quarter" | "year",
): PeriodReturn[] {
  const key = (date: string) => {
    const y = date.slice(0, 4),
      m = Number(date.slice(5, 7));
    return unit === "year"
      ? y
      : unit === "quarter"
        ? `${y}Q${Math.ceil(m / 3)}`
        : date.slice(0, 7);
  };
  const series = (curve: readonly { date: string; value: number }[]) => {
    const out = new Map<string, number>();
    let previous = curve[0]?.value ?? null;
    let current: string | null = null;
    let last = previous;
    for (const point of curve) {
      const period = key(point.date);
      if (period !== current) {
        if (current !== null && previous && last !== null)
          out.set(current, last / previous - 1);
        if (current !== null) previous = last;
        current = period;
      }
      last = point.value;
    }
    if (current !== null && previous && last !== null)
      out.set(current, last / previous - 1);
    return out;
  };
  const strategy = series(equity),
    hold = benchmark ? series(benchmark) : new Map<string, number>();
  return [...strategy.keys()].map((period) => ({
    period,
    strategy: strategy.get(period) ?? null,
    benchmark: hold.get(period) ?? null,
  }));
}
