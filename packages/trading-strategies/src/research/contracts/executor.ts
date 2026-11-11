import type { ResearchPositionBook } from "./position-book.js";

/** Frozen execution evidence and cost quotes supplied by the existing executor. */
export type ResearchCostQuote = {
  costs: { slippageBps: number; sellTaxBps: number };
  commission(amount: number): number;
};
export type ResearchExecutor = ResearchCostQuote & {
  minimumBuy: number;
  buyStep: number;
  maximumOrder: number;
  buyQuantity(cash: number, price: number): number;
  sellQuantity(request: number, held: number): number | null;
  bookBuy(
    book: ResearchPositionBook,
    fill: { date: string; price: number; quantity: number; commission: number },
  ): ResearchPositionBook;
};
