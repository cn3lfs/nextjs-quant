"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
import { cn } from "~/lib/common/classnames";
import { usePanelVisible } from "../workbench/keep-alive";
import { useQuoteRefreshInterval } from "../market/use-quote-session";

/** Headline A-share indices, as on a broker terminal's home screen. */
export const pulseIndices = [
  ["sh000001", "上证指数"],
  ["sz399001", "深证成指"],
  ["sz399006", "创业板指"],
  ["sh000300", "沪深300"],
  ["sh000688", "科创50"],
] as const;

export type PulseQuote = {
  price: number;
  preClose: number;
  amount: number;
};
export const quoteChange = (q: PulseQuote | undefined) =>
  q && q.preClose > 0 && q.price > 0 ? (q.price / q.preClose - 1) * 100 : null;
const toneOf = (change: number | null) =>
  change === null || change === 0
    ? "text-nc-text-3"
    : change > 0
      ? "text-nc-up"
      : "text-nc-down";
const signed = (change: number) =>
  `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;

/**
 * One batched TDX quote request for the indices and the watchlist, refreshed
 * with the trading session (3 s while trading, manual after the close).
 */
export function useOverviewQuotes(watch: readonly string[]) {
  const interval = useQuoteRefreshInterval();
  // Kept-alive but hidden overview: no polling.
  const visible = usePanelVisible();
  const symbols = [...pulseIndices.map(([symbol]) => symbol), ...watch];
  const quotes = api.tdxQuotes.useQuery(symbols, {
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: visible ? interval : false,
  });
  const bySymbol = new Map(
    (quotes.data ?? []).map((q) => [q.symbol, q as PulseQuote]),
  );
  return { bySymbol, error: quotes.error, loading: quotes.isLoading };
}

export function MarketPulse({
  bySymbol,
  error,
}: {
  bySymbol: Map<string, PulseQuote>;
  error: { message: string } | null;
}) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-[var(--nc-gap)]"
      aria-label="主要指数"
      data-testid="market-pulse"
    >
      {pulseIndices.map(([symbol, name]) => {
        const q = bySymbol.get(symbol);
        const change = quoteChange(q);
        return (
          <Link
            key={symbol}
            href={`/market?symbol=${symbol}`}
            className="nc-watch flex-col !items-start !gap-[2px]"
          >
            <span className="text-[11.5px] text-nc-text-3">{name}</span>
            <span
              className={cn(
                "text-[15px] font-medium tabular-nums",
                toneOf(change),
              )}
            >
              {q ? q.price.toFixed(2) : "—"}
            </span>
            <span className={cn("text-[11.5px] tabular-nums", toneOf(change))}>
              {change === null ? (error ? "行情不可用" : "—") : signed(change)}
              {q && q.amount > 0 && (
                <span className="ml-2 text-nc-text-4">
                  {(q.amount / 1e8).toFixed(0)}亿
                </span>
              )}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/** Price and change for a watchlist card. */
export function WatchQuote({ quote }: { quote: PulseQuote | undefined }) {
  const change = quoteChange(quote);
  return (
    <span className="ml-auto flex flex-col items-end tabular-nums">
      <span className={cn("text-[13px]", toneOf(change))}>
        {quote ? quote.price.toFixed(2) : "—"}
      </span>
      <span className={cn("text-[11px]", toneOf(change))}>
        {change === null ? "" : signed(change)}
      </span>
    </span>
  );
}
