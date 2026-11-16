import type { PortfolioSleeve } from "quant-backtest";

/** The frozen R2a paper policy; this is a research scenario, not an approval to trade. */
export function paperSleevePolicy(
  market: "cn-equity" | "crypto",
  sleeve: string,
  symbolCount: number,
): PortfolioSleeve {
  return {
    id: sleeve,
    share: 1,
    riskPerTrade: sleeve === "low-zone" ? 0.1 : 0.02,
    maxPositions: market === "crypto" ? symbolCount : 10,
  };
}
