import { runPortfolio, type PortfolioRequest } from "quant-backtest";

export function backtestStrategy(
  request: PortfolioRequest,
  progress?: (done: number, total: number) => void,
) {
  return runPortfolio(request, progress);
}
