import { formatNumber } from "trading-strategy-core/format-number";
import { chartPricePrecision } from "~/lib/chart/chart-symbol";
import type { AccountPosition } from "~/lib/portfolio/account-workspace";

const perUnit = (
  value: number | null,
  currency: AccountPosition["currency"],
  symbol: string,
) =>
  value === null || !Number.isFinite(value)
    ? null
    : `${formatNumber(value, chartPricePrecision(symbol, value))} ${currency}`;

/** Per-unit cost and the valuation price already read for the position. Each
 *  value is shown on its own line with the existing chart price precision, so
 *  ETF three-decimal and fractional crypto quotes are not rounded to zero. A
 *  missing one stays missing and is never derived from the other. The price
 *  timestamp moves to the hover title so the row stays short. */
export function PositionCostPrice({
  symbol,
  cost,
  price,
  currency,
  at,
}: Pick<AccountPosition, "symbol" | "cost" | "price" | "currency" | "at">) {
  return (
    <span className="block whitespace-nowrap text-right text-sm tabular-nums">
      <span className="block">
        成本 {perUnit(cost, currency, symbol) ?? "缺失"}
      </span>
      <span className="block text-nc-text-3" title={`原价时点 ${at ?? "未知"}`}>
        现价 {perUnit(price, currency, symbol) ?? "缺失"}
      </span>
    </span>
  );
}
