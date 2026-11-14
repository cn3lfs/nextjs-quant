import type { Bar, Period } from "trading-strategy-core/bars";

/** Price facts and archive identity supplied by the caller, without data acquisition. */
export type GrowthPriceInput = {
  id: string;
  hash: string;
  symbol: string;
  period: Period;
  adjustment: "none" | "forward" | "backward";
  historicalAsOf?: string;
  bars: readonly Bar[];
};
