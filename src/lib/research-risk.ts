import type { BacktestCosts } from "./backtest-costs";
import {
  researchBuyQuantity,
  researchCommission,
  type ResearchExecutionRules,
} from "./research-execution";
import { big, bpsOf, moneyMul, toNumber } from "./money";

export function plannedStopRisk(
  quantity: number,
  entry: number,
  stop: number,
  costs: BacktestCosts,
) {
  const estimatedExit = toNumber(
    big(stop).times(big(1).minus(big(costs.slippageBps).div(10000))),
  );
  const entryAmount = moneyMul(quantity, entry);
  const exitAmount = moneyMul(quantity, estimatedExit);
  return toNumber(
    big(entryAmount)
      .minus(exitAmount)
      .plus(researchCommission(entryAmount, costs))
      .plus(researchCommission(exitAmount, costs))
      .plus(bpsOf(exitAmount, costs.sellTaxBps)),
  );
}

/** Budget includes estimated round-trip costs; a later overnight gap can still
 * exceed it. Previous-close equity is supplied by the portfolio, never today's
 * close. Quantity steps/minimums come from the frozen execution evidence. */
export function researchRiskQuantity(input: {
  cash: number;
  equity: number;
  price: number;
  stop: number;
  fraction: number;
  maxWeight: number;
  rules: ResearchExecutionRules;
  costs: BacktestCosts;
}) {
  const { cash, equity, price, stop, fraction, maxWeight, rules, costs } =
    input;
  if (
    ![cash, equity, price, stop, fraction, maxWeight].every(Number.isFinite) ||
    equity <= 0 ||
    price <= 0 ||
    stop <= 0 ||
    stop >= price ||
    fraction <= 0 ||
    maxWeight <= 0
  )
    return 0;
  const maximum = researchBuyQuantity(
    Math.min(cash, equity * maxWeight),
    price,
    rules,
    costs,
  );
  if (!maximum) return 0;
  const riskBudget = equity * fraction;
  if (plannedStopRisk(rules.minimumBuy, price, stop, costs) > riskBudget)
    return 0;
  let low = 0,
    high = Math.floor((maximum - rules.minimumBuy) / rules.buyStep);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const quantity = rules.minimumBuy + mid * rules.buyStep;
    if (plannedStopRisk(quantity, price, stop, costs) <= riskBudget) low = mid;
    else high = mid - 1;
  }
  return rules.minimumBuy + low * rules.buyStep;
}
