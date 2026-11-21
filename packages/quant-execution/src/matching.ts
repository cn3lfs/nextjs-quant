import { slippedPrice, type Atoms } from "./atoms.js";
import type { CostRates, ExecutionQuote, OrderIntent } from "./types.js";

export type MatchResult =
  { ok: true; price: Atoms } | { ok: false; reason: string };

/** Default policy: next completed bar open, adverse slippage, conservative
 * rejection at locked limits / suspension / one-price bars. */
export function matchOpen(
  order: Pick<OrderIntent, "side">,
  quote: ExecutionQuote,
  rates: CostRates,
): MatchResult {
  if (!quote.tradable) return { ok: false, reason: "停牌或缺少交易状态" };
  if (quote.volume <= 0n) return { ok: false, reason: "停牌或零成交" };
  if (quote.high <= 0n || quote.low <= 0n || quote.open <= 0n)
    return { ok: false, reason: "成交行情无效" };
  if (quote.high === quote.low)
    return { ok: false, reason: "一字行情，保守不成交" };
  if (
    order.side === "buy" &&
    quote.limitUp != null &&
    quote.open >= quote.limitUp
  )
    return { ok: false, reason: "开盘涨停，无法证明买入成交" };
  if (
    order.side === "sell" &&
    quote.limitDown != null &&
    quote.open <= quote.limitDown
  )
    return { ok: false, reason: "开盘跌停，无法证明卖出成交" };

  const price = slippedPrice(quote.open, order.side, rates.slippageBps);
  if (price > quote.high || price < quote.low)
    return { ok: false, reason: "滑点成交价超出可观察价格范围" };
  if (order.side === "buy" && quote.limitUp != null && price > quote.limitUp)
    return { ok: false, reason: "滑点成交价超出涨停价" };
  if (
    order.side === "sell" &&
    quote.limitDown != null &&
    price < quote.limitDown
  )
    return { ok: false, reason: "滑点成交价低于跌停价" };
  return { ok: true, price };
}
