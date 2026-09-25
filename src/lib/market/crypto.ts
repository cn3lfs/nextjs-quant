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

/** User-selectable crypto market source; `auto` walks the fallback chain. */
export const cryptoSourceSchema = z.enum([
  "auto",
  "binance",
  "okx",
  "gate",
  "coinbase",
  "bybit",
]);
export type CryptoSource = z.infer<typeof cryptoSourceSchema>;
export type CryptoVenue = Exclude<CryptoSource, "auto">;
export const cryptoSourceLabels: Record<CryptoSource, string> = {
  auto: "自动（币安 → OKX → Gate → Coinbase → Bybit）",
  binance: "币安",
  okx: "OKX",
  gate: "Gate.io",
  coinbase: "Coinbase（无 30 分钟/周/月）",
  bybit: "Bybit",
};

/**
 * Venue instrument id for a `cx` symbol. The quote asset is never swapped
 * (e.g. USDT for USD), so every source prices the same book; a venue that
 * lacks the pair reports it instead. Returns null when the pair cannot be split.
 */
export function venueSymbol(venue: CryptoVenue, symbol: string) {
  const { base, quote } = cryptoAssets(symbol);
  if (!quote) return venue === "binance" || venue === "bybit" ? cryptoPair(symbol) : null;
  switch (venue) {
    case "binance":
    case "bybit":
      return `${base}${quote}`;
    case "okx":
      return `${base}-${quote}`;
    case "gate":
      return `${base}_${quote}`;
    case "coinbase":
      return `${base}-${quote}`;
  }
}
