import type { Bar } from "./domain";
import type { BacktestCosts } from "./backtest-costs";
import { big, bpsOf, moneyMul, toNumber, bigFloor, bigMin } from "./money";

/** Historical daily constraints must come from evidence or an explicitly
 * labelled scenario. Current ST/IPO status is not a historical substitute.
 */
export type ResearchExecutionRules = {
  evidence: string;
  minimumBuy: number;
  buyStep: number;
  maximumOrder: number;
  limitUp: number | null;
  limitDown: number | null;
  tradable: boolean;
  minimumSell?: number;
  sellStep?: number;
  sellOddLotAll?: boolean;
  maximumSell?: number;
};
export function researchSellQuantity(
  desired: number,
  remaining: number,
  rules: ResearchExecutionRules,
) {
  const { minimumSell, sellStep, sellOddLotAll, maximumSell } = rules;
  if (
    !Number.isFinite(desired) ||
    desired < 0 ||
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    minimumSell == null ||
    sellStep == null ||
    sellOddLotAll == null ||
    maximumSell == null ||
    ![minimumSell, sellStep, maximumSell].every(
      (v) => Number.isSafeInteger(v) && v > 0,
    ) ||
    minimumSell > maximumSell
  )
    return null;
  const limit = Math.floor(Math.min(desired + 1e-8, remaining, maximumSell));
  if (sellOddLotAll && limit === remaining) return remaining;
  return limit < minimumSell
    ? 0
    : minimumSell + Math.floor((limit - minimumSell) / sellStep) * sellStep;
}
export function researchCommission(amount: number, costs: BacktestCosts) {
  return Math.max(costs.minimumCommission, bpsOf(amount, costs.commissionBps));
}

export function researchFill(
  bar: Bar | undefined,
  side: "buy" | "sell",
  rules: ResearchExecutionRules | null,
  costs: BacktestCosts,
): { price: number; reason: null } | { price: null; reason: string } {
  if (!rules || !rules.evidence)
    return { price: null, reason: "缺少当日交易限制依据" };
  if (!bar || !rules.tradable || bar.volume <= 0)
    return { price: null, reason: "停牌或缺少可交易行情" };
  if (
    ![bar.open, bar.high, bar.low, bar.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    bar.high < Math.max(bar.open, bar.close) ||
    bar.low > Math.min(bar.open, bar.close)
  )
    return { price: null, reason: "成交行情无效" };
  // Daily bars cannot establish queue priority at a limit price.
  if (
    side === "buy" &&
    rules.limitUp !== null &&
    bar.open >= rules.limitUp - 0.000001
  )
    return { price: null, reason: "开盘涨停，无法证明买入成交" };
  if (
    side === "sell" &&
    rules.limitDown !== null &&
    bar.open <= rules.limitDown + 0.000001
  )
    return { price: null, reason: "开盘跌停，无法证明卖出成交" };
  if (bar.high === bar.low)
    return { price: null, reason: "一字行情，保守不成交" };
  const price =
    bar.open * (1 + ((side === "buy" ? 1 : -1) * costs.slippageBps) / 10000);
  if (
    price > bar.high ||
    price < bar.low ||
    (rules.limitUp !== null && price > rules.limitUp) ||
    (rules.limitDown !== null && price < rules.limitDown)
  )
    return { price: null, reason: "滑点成交价超出可观察价格范围" };
  return { price, reason: null };
}

export function researchBuyQuantity(
  budget: number,
  price: number,
  rules: ResearchExecutionRules,
  costs: BacktestCosts,
) {
  if (![budget, price].every(Number.isFinite) || budget <= 0 || price <= 0)
    return 0;
  if (
    ![rules.minimumBuy, rules.buyStep, rules.maximumOrder].every(
      (value) => Number.isInteger(value) && value > 0,
    )
  )
    throw new Error("申报数量规则无效");
  const priceWithCommissionRate = big(price).times(
    big(1).plus(big(costs.commissionBps).div(10000)),
  );
  const affordable = bigFloor(
    bigMin(
      big(budget).minus(costs.minimumCommission).div(price),
      big(budget).div(priceWithCommissionRate),
      big(rules.maximumOrder),
    ),
  );
  if (affordable < rules.minimumBuy) return 0;
  const quantity =
    rules.minimumBuy +
    Math.floor((affordable - rules.minimumBuy) / rules.buyStep) * rules.buyStep;
  const orderAmount = moneyMul(quantity, price);
  return toNumber(big(orderAmount).plus(researchCommission(orderAmount, costs))) <=
    budget + 1e-8
    ? quantity
    : 0;
}
