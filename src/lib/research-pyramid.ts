import type { BacktestCosts } from "./backtest-costs";
import {
  researchBuyQuantity,
  researchCommission,
  researchSellQuantity,
  type ResearchExecutionRules,
} from "./research-execution";
import {
  researchBookBuy,
  type ResearchPositionBook,
} from "./research-position-book";

export function researchRoundedBuy(
  desired: number,
  rules: ResearchExecutionRules,
) {
  if (!Number.isFinite(desired) || desired < rules.minimumBuy) return 0;
  return (
    rules.minimumBuy +
    Math.floor(
      (Math.min(desired + 1e-8, rules.maximumOrder) - rules.minimumBuy) /
        rules.buyStep,
    ) *
      rules.buyStep
  );
}

/** Frozen current sell rules and one price for all future chunks are an
 * explicit planning estimate, not a claim that future exits can fill. */
export function researchPlannedProceeds(
  quantity: number,
  stop: number,
  rules: ResearchExecutionRules,
  costs: BacktestCosts,
) {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(stop) ||
    stop <= 0
  )
    return null;
  const chunk = researchSellQuantity(quantity, quantity, rules);
  if (chunk == null || chunk <= 0) return null;
  const count = Math.floor(quantity / chunk);
  const tail = quantity - count * chunk;
  if (tail > 0 && researchSellQuantity(tail, tail, rules) !== tail) return null;
  const price = stop * (1 - costs.slippageBps / 10000);
  return (
    quantity * price * (1 - costs.sellTaxBps / 10000) -
    count * researchCommission(chunk * price, costs) -
    (tail ? researchCommission(tail * price, costs) : 0)
  );
}

export function researchPyramidOrder(input: {
  book: ResearchPositionBook;
  date: string;
  price: number;
  desired: number;
  stage: number;
  stop: number;
  firstPrice: number;
  stressBuffer: number;
  cash: number;
  equity: number;
  otherValue: number;
  riskBudget: number;
  maxWeight: number;
  maxTotalWeight: number;
  rules: ResearchExecutionRules;
  costs: BacktestCosts;
  pullback?: { level: number; requireProfit: boolean };
}) {
  const { book, price, rules, costs } = input;
  if (
    price <= input.stop ||
    (input.pullback && price < input.pullback.level) ||
    ((!input.pullback || input.pullback.requireProfit) &&
      (price <= input.firstPrice ||
        price * book.remainingQuantity <= book.remainingCost))
  )
    return {
      order: null,
      reason: input.pullback
        ? input.pullback.requireProfit
          ? "第二笔开盘不再盈利或失守保护线，暂不补齐"
          : "第二笔开盘失守保护线，暂不补齐"
        : "开盘已非盈利头寸或失守止损，禁止摊低成本",
    };
  const maximum = researchRoundedBuy(
    Math.min(
      input.desired,
      researchBuyQuantity(input.cash, price, rules, costs),
    ),
    rules,
  );
  const candidate = (quantity: number) => {
    const commission = researchCommission(quantity * price, costs);
    const next = researchBookBuy(book, {
      date: input.date,
      price,
      quantity,
      commission,
    });
    const netEquity = input.equity - commission;
    if (
      next.remainingQuantity * price > netEquity * input.maxWeight + 1e-8 ||
      next.remainingQuantity * price + input.otherValue >
        netEquity * input.maxTotalWeight + 1e-8
    )
      return null;
    let stop = Math.max(input.stop, input.pullback?.level ?? input.firstPrice);
    if (input.stage === 0 && !input.pullback) {
      // Find the remaining book's estimated net breakeven, including each
      // exit chunk's fees and configured stress/slippage. Never lower a line.
      let low = stop,
        high = price;
      const proceeds = researchPlannedProceeds(
        next.remainingQuantity,
        high * (1 - input.stressBuffer),
        rules,
        costs,
      );
      if (proceeds == null || proceeds < next.remainingCost) return null;
      for (let iteration = 0; iteration < 60; iteration++) {
        const middle = (low + high) / 2;
        const value = researchPlannedProceeds(
          next.remainingQuantity,
          middle * (1 - input.stressBuffer),
          rules,
          costs,
        );
        if (value == null) return null;
        if (value >= next.remainingCost) high = middle;
        else low = middle;
      }
      stop = Math.max(stop, high);
    }
    const proceeds = researchPlannedProceeds(
      next.remainingQuantity,
      stop * (1 - input.stressBuffer),
      rules,
      costs,
    );
    if (proceeds == null || stop >= price) return null;
    const risk = Math.max(0, next.remainingCost - proceeds);
    if (risk > input.riskBudget + 1e-8) return null;
    return { book: next, quantity, commission, stop, plannedRisk: risk };
  };
  // Independent sell increments can leave holes among valid buy quantities;
  // feasibility is not monotone and must not be binary-searched.
  for (
    let quantity = maximum;
    quantity >= rules.minimumBuy;
    quantity -= rules.buyStep
  ) {
    const order = candidate(quantity);
    if (order) return { order, reason: null };
  }
  return {
    order: null,
    reason: "加仓现金、总仓位或固定风险预算不足，或无法证明按当前规则退出",
  };
}
