import { z } from "zod";
import { isPriceScaleThreeFund } from "./security-classification";
export const chartPricePrecision = (symbol: string): 2 | 3 =>
  isPriceScaleThreeFund(symbol) ? 3 : 2;
/** 仅用于图表；交易、研究证券池和身份核验仍使用 domain.symbolSchema。 */
export const chartSymbolSchema = z
  .string()
  .regex(/^(?:(?:sh|sz|bj)\d{6}|pt[0-9A-Z]{6,12}|emBK\d{4})$/);
export const isSectorChartSymbol = (symbol: string) =>
  /^(pt|emBK)/.test(symbol);
export function normalizeChartSymbol(value: string): string | null {
  const text = value.trim();
  const normalized =
    text.slice(0, 2).toLowerCase() + text.slice(2).toUpperCase();
  return chartSymbolSchema.safeParse(normalized).success ? normalized : null;
}
