import type {
  ResearchExecutor,
  ResearchCostQuote,
} from "../contracts/executor.js";
import type { ResearchPositionBook } from "../contracts/position-book.js";
import { big, bpsOf, moneyMul, toNumber } from "trading-strategy-core/money";

export function plannedStopRisk(
  quantity: number,
  entry: number,
  stop: number,
  execution: ResearchCostQuote,
) {
  const estimatedExit = toNumber(
    big(stop).times(big(1).minus(big(execution.costs.slippageBps).div(10000))),
  );
  const entryAmount = moneyMul(quantity, entry);
  const exitAmount = moneyMul(quantity, estimatedExit);
  return toNumber(
    big(entryAmount)
      .minus(exitAmount)
      .plus(execution.commission(entryAmount))
      .plus(execution.commission(exitAmount))
      .plus(bpsOf(exitAmount, execution.costs.sellTaxBps)),
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
  execution: ResearchExecutor;
}) {
  const { cash, equity, price, stop, fraction, maxWeight, execution } = input;
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
  const maximum = execution.buyQuantity(
    Math.min(cash, equity * maxWeight),
    price,
  );
  if (!maximum) return 0;
  const riskBudget = equity * fraction;
  if (
    plannedStopRisk(execution.minimumBuy, price, stop, execution) > riskBudget
  )
    return 0;
  let low = 0,
    high = Math.floor((maximum - execution.minimumBuy) / execution.buyStep);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const quantity = execution.minimumBuy + mid * execution.buyStep;
    if (plannedStopRisk(quantity, price, stop, execution) <= riskBudget)
      low = mid;
    else high = mid - 1;
  }
  return execution.minimumBuy + low * execution.buyStep;
}
