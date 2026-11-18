import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";
const bars = Array.from({ length: 340 }, (_, i) => ({
  date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 10000,
  amount: 1000000,
}));
it("study holding limit starts at actual fill and exits at following open", () => {
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 100000,
    start: bars[310]!.date,
    end: bars[339]!.date,
    calendar: bars.slice(310).map((b) => b.date),
    strategies: [
      {
        id: "confirmed-fill",
        version: 1,
        market: "crypto",
        period: "day",
        universe: { kind: "symbols", symbols: ["BTCUSDT"] },
        entry: { kind: "constant", value: true },
        exit: { rule: { kind: "study-rule", strategy: "rsi2", side: "exit" } },
        sizing: { kind: "weight", weight: 0.1 },
        sleeve: "swing",
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          minimum: 0.001,
          step: 0.001,
          maximum: 1000000,
          evidence: "fixture",
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const result = runPortfolio(request);
  expect(result.fills[0]).toMatchObject({ side: "buy", date: bars[311]!.date });
  expect(result.fills[1]).toMatchObject({
    side: "sell",
    signalAt: bars[321]!.date,
    date: bars[322]!.date,
  });
});
