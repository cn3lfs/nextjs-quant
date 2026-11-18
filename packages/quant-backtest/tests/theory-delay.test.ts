import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";
import { theoryStrategy } from "trading-strategies";

it("rejects blocked buys without ghost positions, then uses the new signal and retains blocked exits", () => {
  const bars = Array.from({ length: 325 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 102,
    low: 98,
    close: 100,
    volume: 1000,
    amount: 100000,
  }));
  const set = (i: number, patch: Partial<(typeof bars)[number]>) =>
    Object.assign(bars[i]!, patch);
  set(309, { high: 101, low: 99 });
  set(310, { open: 100, high: 104, low: 99, close: 103 });
  // The first order is rejected at 311. The market subsequently forms a new NR4.
  for (const i of [311, 312, 313])
    set(i, { open: 105, high: 110, low: 100, close: 105 });
  set(314, { open: 104, high: 105, low: 103, close: 104 });
  set(315, { open: 104, high: 109, low: 104, close: 108 });
  set(316, { open: 108, high: 109, low: 107, close: 108 });
  set(317, { open: 108, high: 109, low: 101, close: 102 });
  set(318, { open: 102, high: 103, low: 100, close: 101 });
  set(319, { open: 101, high: 102, low: 100, close: 101 });
  const request: PortfolioRequest = {
    market: "crypto",
    initial: 100000,
    start: bars[310]!.date,
    end: bars[324]!.date,
    calendar: bars.slice(310).map((b) => b.date),
    strategies: [theoryStrategy("theory-nr4-close", "crypto", ["BTCUSDT"])],
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
        execution: (bar) => ({
          minimum: 0.001,
          step: 0.001,
          maximum: 1000000,
          evidence: "fixture",
          tradable:
            bar?.date !== bars[311]!.date && bar?.date !== bars[318]!.date,
          limitUp: null,
          limitDown: null,
        }),
      },
    ],
  };
  const result = runPortfolio(request);
  expect(result.fills).toHaveLength(2);
  expect(result.orders[0]).toMatchObject({
    side: "buy",
    signalAt: bars[310]!.date,
    status: "rejected",
    attempts: 1,
  });
  expect(result.fills[0]).toMatchObject({
    side: "buy",
    signalAt: bars[315]!.date,
    date: bars[316]!.date,
  });
  // Close 102 breaks the new 103-based protection, but not the old 99-based anchor
  // or the trailing channel low 98. The blocked sell remains the same intent.
  expect(result.fills[1]).toMatchObject({
    side: "sell",
    signalAt: bars[317]!.date,
    date: bars[319]!.date,
  });
  const sell = result.orders.find((o) => o.side === "sell")!;
  expect(sell).toMatchObject({
    attempts: 2,
    status: "filled",
    signalAt: bars[317]!.date,
  });
});
