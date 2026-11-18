import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";

function request(period: "day" | "5m"): PortfolioRequest {
  const dates =
    period === "5m"
      ? [
          "2026-11-16T23:50:00Z",
          "2026-11-16T23:55:00Z",
          "2026-11-17T00:00:00Z",
          "2026-11-17T00:05:00Z",
        ]
      : ["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"];
  const bars = dates.map((date, index) => ({
    date,
    open: 10,
    close: 10 + index,
    high: 14,
    low: 9,
    volume: 10000,
    amount: 100000,
  }));
  return {
    market: "crypto",
    initial: 1000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    strategies: [
      {
        id: "clock",
        version: 1,
        market: "crypto",
        period,
        universe: { kind: "symbols", symbols: ["BTCUSDT"] },
        entry: { kind: "constant", value: true },
        exit: {},
        sizing: { kind: "weight", weight: 1 },
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
}
it("assigns midnight end-labelled crypto bars to the previous day without lifecycle features", () => {
  const result = runPortfolio(request("5m"));
  expect(result.equity.map((row) => [row.date, row.equity])).toEqual([
    ["2026-11-16", 1200],
    ["2026-11-17", 1300],
  ]);
  expect(result.curve).toHaveLength(4);
  expect(result).not.toHaveProperty("bookDecisions");
});
it("preserves open-labelled crypto daily observations", () => {
  const result = runPortfolio(request("day"));
  expect(result.equity.map((row) => [row.date, row.equity])).toEqual([
    ["2026-11-14", 1000],
    ["2026-11-15", 1100],
    ["2026-11-16", 1200],
    ["2026-11-17", 1300],
  ]);
});
