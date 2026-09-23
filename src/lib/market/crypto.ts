import { z } from "zod";
import type { ChartPeriod } from "../chart/chart-view";

/**
 * Crypto chart symbols: `cx` + Binance spot pair, e.g. `cxBTCUSDT`. The prefix
 * keeps them apart from A-share codes, so every A-share-only path (adjustment,
 * RPS, TDX panels, the A-share watchlist) can bypass them explicitly.
 */
export const cryptoSymbolSchema = z.string().regex(/^cx[A-Z0-9]{5,20}$/);
export const isCryptoSymbol = (symbol: string) =>
  cryptoSymbolSchema.safeParse(symbol).success;
export const cryptoPair = (symbol: string) => symbol.slice(2);
export const cryptoSymbol = (pair: string) => `cx${pair.toUpperCase()}`;

/** Quote assets recognised when splitting a pair for display units. */
const quotes = ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB"] as const;
export function cryptoAssets(symbol: string) {
  const pair = cryptoPair(symbol);
  const quote = quotes.find((q) => pair.endsWith(q) && pair.length > q.length);
  return quote
    ? { base: pair.slice(0, -quote.length), quote }
    : { base: pair, quote: "" };
}

export const defaultCryptoPairs = [
  { symbol: "cxBTCUSDT", name: "比特币 BTC/USDT" },
  { symbol: "cxETHUSDT", name: "以太坊 ETH/USDT" },
  { symbol: "cxBNBUSDT", name: "币安币 BNB/USDT" },
  { symbol: "cxSOLUSDT", name: "Solana SOL/USDT" },
  { symbol: "cxXRPUSDT", name: "瑞波币 XRP/USDT" },
  { symbol: "cxDOGEUSDT", name: "狗狗币 DOGE/USDT" },
] as const;

export function cryptoDisplayName(symbol: string) {
  const known = defaultCryptoPairs.find((p) => p.symbol === symbol);
  if (known) return known.name;
  const { base, quote } = cryptoAssets(symbol);
  return quote ? `${base}/${quote}` : cryptoPair(symbol);
}

/** Workbench chart period → Binance kline interval (native weeks and months). */
export const binanceInterval: Record<ChartPeriod, string> = {
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "60m": "1h",
  day: "1d",
  week: "1w",
  month: "1M",
};

/**
 * Bar label for a kline. Daily and longer bars use the UTC open date; intraday
 * bars use their UTC end time, matching the end-labelled minute bars elsewhere.
 */
export function cryptoBarDate(
  openTime: number,
  closeTime: number,
  period: ChartPeriod,
) {
  if (period === "day" || period === "week" || period === "month")
    return new Date(openTime).toISOString().slice(0, 10);
  return new Date(closeTime + 1).toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
