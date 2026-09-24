import { z } from "zod";
import { isPriceScaleThreeFund } from "../market/security-classification";
import { isCryptoSymbol } from "../market/crypto";
import { futuresContract, isFuturesSymbol } from "../market/futures";
/** Decimal places on the price axis. Crypto quotes scale with price level. */
export const chartPricePrecision = (symbol: string, price?: number): number =>
  isFuturesSymbol(symbol)
    ? futuresContract(symbol)!.precision
    : isCryptoSymbol(symbol)
    ? price === undefined || price >= 100
      ? 2
      : price >= 1
        ? 4
        : price >= 0.01
          ? 6
          : 8
    : isPriceScaleThreeFund(symbol)
      ? 3
      : 2;
/** 仅用于图表；交易、研究证券池和身份核验仍使用 domain.symbolSchema。 */
export const chartSymbolSchema = z
  .string()
  .regex(/^(?:(?:sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12}|emBK\d{4}|cx[A-Z0-9]{5,20}|fu[A-Z0-9]{2,10})$/);
export const isSectorChartSymbol = (symbol: string) =>
  /^(pt|emBK)/.test(symbol);
export { isCryptoSymbol as isCryptoChartSymbol };
export { isFuturesSymbol as isFuturesChartSymbol };
/** Crypto and futures charts have their own pages and no A-share overlays. */
export const isForeignMarketChartSymbol = (symbol: string) =>
  isCryptoSymbol(symbol) || isFuturesSymbol(symbol);
/** Sector and crypto charts skip every A-share-only path (adjustment, RPS,
 *  holdings, TDX quotes, the A-share watchlist). */
export const isNonAShareChartSymbol = (symbol: string) =>
  isSectorChartSymbol(symbol) ||
  isCryptoSymbol(symbol) ||
  isFuturesSymbol(symbol);
/** 深链：其他页面用 /market?symbol=sh600519 打开行情图表页并加载该证券K线。 */
export function chartSymbolHref(symbol: string) {
  return isCryptoSymbol(symbol)
    ? `/crypto?pair=${encodeURIComponent(symbol.slice(2))}`
    : isFuturesSymbol(symbol)
    ? `/futures?code=${encodeURIComponent(symbol.slice(2))}`
    : `/market?symbol=${encodeURIComponent(symbol)}`;
}
export function readChartSymbolParam(search: string): string | null {
  return normalizeChartSymbol(new URLSearchParams(search).get("symbol") ?? "");
}
export function normalizeChartSymbol(value: string): string | null {
  const text = value.trim();
  const normalized =
    text.slice(0, 2).toLowerCase() + text.slice(2).toUpperCase();
  // Crypto pairs open on their own page (/crypto), never in the A-share view.
  return chartSymbolSchema.safeParse(normalized).success &&
    !isCryptoSymbol(normalized) &&
    !isFuturesSymbol(normalized)
    ? normalized
    : null;
}
