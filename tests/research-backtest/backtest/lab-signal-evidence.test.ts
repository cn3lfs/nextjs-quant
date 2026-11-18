import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import {
  tripleScreenStrategy,
  type TripleScreenSeries,
} from "trading-strategies";
import { labBacktestEvidence } from "~/server/research/lab-backtest-evidence";

it("reports unknown inputs even when no orders or fills exist", () => {
  const bars = ["2026-10-12", "2026-10-13"].map((date) => ({
    date,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
  const execution: TripleScreenSeries = {
    period: "day",
    sourceHash: "fixture",
    adjustmentId: "raw",
    calendarHash: "UTC",
    slots: bars.map((bar) => ({
      bar,
      priceScale: 1,
      availableAt: new Date(Date.parse(bar.date) + 86400000).toISOString(),
    })),
  };
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 10000,
    start: bars[0]!.date,
    end: bars[1]!.date,
    calendar: bars.map((b) => b.date),
    strategies: [tripleScreenStrategy("week-day", "crypto", ["cxBTCUSDT"])],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.01, maxPositions: 1 }],
    instruments: [
      {
        symbol: "cxBTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          minimum: 0.001,
          step: 0.001,
          tradable: true,
          limitUp: null,
          limitDown: null,
        },
        external: {
          tripleScreen: {
            market: "crypto",
            variant: "week-day",
            tick: 0.01,
            execution,
            setup: execution,
            background: { ...execution, period: "week", slots: [] },
          },
        },
      },
    ],
  };
  const result = runPortfolio(request);
  expect(result.orders).toHaveLength(0);
  const evidence = labBacktestEvidence(request, result);
  expect(evidence.signals).toHaveLength(0);
  expect(evidence.diagnostics).toMatchObject([
    { evaluated: 2, unknown: 2, reasons: { "incomplete-period-or-warmup": 2 } },
  ]);
});
