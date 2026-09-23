import { z } from "zod";
import { isPriceScaleThreeFund } from "../market/security-classification";
export const chartPricePrecision = (symbol: string): 2 | 3 =>
  isPriceScaleThreeFund(symbol) ? 3 : 2;
/** 仅用于图表；交易、研究证券池和身份核验仍使用 domain.symbolSchema。 */
export const chartSymbolSchema = z
  .string()
  .regex(/^(?:(?:sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12}|emBK\d{4})$/);
export const isSectorChartSymbol = (symbol: string) =>
  /^(pt|emBK)/.test(symbol);
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
