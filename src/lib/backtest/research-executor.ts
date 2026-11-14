import {
  affordableQuantity,
  sellQuantity,
  commissionFor,
  type ExecutionRules,
} from "quant-backtest/execution";
import type { ExecutionCosts } from "trading-strategy-core/costs";
import type {
  ResearchCostQuote,
  ResearchExecutor,
} from "trading-strategies/research/contracts/executor";
import { researchBookBuy } from "../research/analysis/research-position-book";

/** Bind frozen execution evidence; pure strategy policies never import the engine. */
export function researchCostQuote(costs: ExecutionCosts): ResearchCostQuote {
  return { costs, commission: (amount) => commissionFor(amount, costs) };
}
export function researchExecutor(
  rules: ExecutionRules,
  costs: ExecutionCosts,
): ResearchExecutor {
  return {
    ...researchCostQuote(costs),
    minimumBuy: rules.minimumBuy,
    buyStep: rules.buyStep,
    maximumOrder: rules.maximumOrder,
    buyQuantity: (cash, price) => affordableQuantity(cash, price, rules, costs),
    sellQuantity: (request, held) => sellQuantity(request, held, rules),
    bookBuy: researchBookBuy,
  };
}
