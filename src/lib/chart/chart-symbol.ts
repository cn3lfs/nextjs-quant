import { z } from "zod";
import { isPriceScaleThreeFund } from "../market/security-classification";
import { isCryptoSymbol } from "../market/crypto";
/** Decimal places on the price axis. Crypto quotes scale with price level. */
export const chartPricePrecision = (symbol: string, price?: number): number =>
  isCryptoSymbol(symbol)
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
  .regex(/^(?:(?:sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12}|emBK\d{4}|cx[A-Z0-9]{5,20})$/);
export const isSectorChartSymbol = (symbol: string) =>
  /^(pt|emBK)/.test(symbol);
export { isCryptoSymbol as isCryptoChartSymbol };
/** Sector and crypto charts skip every A-share-only path (adjustment, RPS,
 *  holdings, TDX quotes, the A-share watchlist). */
export const isNonAShareChartSymbol = (symbol: string) =>
  isSectorChartSymbol(symbol) || isCryptoSymbol(symbol);
/** 深链：其他页面用 /market?symbol=sh600519 打开行情图表页并加载该证券K线。 */
export function chartSymbolHref(symbol: string) {
  return `/market?symbol=${encodeURIComponent(symbol)}`;
}
export function readChartSymbolParam(search: string): string | null {
  return normalizeChartSymbol(new URLSearchParams(search).get("symbol") ?? "");
}
export function normalizeChartSymbol(value: string): string | null {
  const text = value.trim();
  const normalized =
    text.slice(0, 2).toLowerCase() + text.slice(2).toUpperCase();
  return chartSymbolSchema.safeParse(normalized).success ? normalized : null;
}
