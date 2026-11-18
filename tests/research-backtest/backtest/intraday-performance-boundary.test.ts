import { describe, it, expect } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { dailyEquity } from "~/lib/backtest/daily-equity";

describe("intraday engine to performance boundary", () => {
  it("keeps UTC midnight in the completed prior session before daily compression", () => {
    const dates = [
      "2026-11-16T23:50:00Z",
      "2026-11-16T23:55:00Z",
      "2026-11-17T00:00:00Z",
    ];
    const bars = dates.map((date) => ({
      date,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
      amount: 10000,
    }));
    const request: PortfolioRequest = {
      market: "crypto",
      initial: 10000,
      start: dates[0]!,
      end: dates[2]!,
      calendar: dates,
      instruments: [
        {
          symbol: "cxBTCUSDT",
          market: "crypto",
          bars,
          signalBars: bars,
          execution: {
            evidence: "test constant-false strategy",
            minimum: 0.001,
            step: 0.001,
            limitUp: null,
            limitDown: null,
            tradable: true,
          },
        },
      ],
      strategies: [
        {
          id: "daily-boundary",
          version: 1,
          market: "crypto",
          period: "5m",
          universe: { kind: "symbols", symbols: ["cxBTCUSDT"] },
          entry: { kind: "constant", value: false },
          exit: { rule: { kind: "constant", value: false } },
          sizing: { kind: "weight", weight: 0.1 },
          sleeve: "swing",
        },
      ],
      sleeves: [{ id: "swing", share: 1, maxPositions: 1, riskPerTrade: 0.01 }],
    };
    const result = runPortfolio(request);
    expect(result.curve).toHaveLength(3);
    expect(dailyEquity(result.curve)).toEqual([
      { date: "2026-11-16", value: 10000 },
    ]);
    expect(dailyEquity(result.equity)).toEqual(dailyEquity(result.curve));
  });
});
