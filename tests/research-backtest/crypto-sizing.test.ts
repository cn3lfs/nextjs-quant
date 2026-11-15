import { describe, expect, it } from "vitest";
import { sizeCryptoResearch } from "~/server/research/crypto-sizing";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
const dates = Array.from({ length: 65 }, (_, i) =>
  new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
);
function request(): PortfolioRequest {
  return {
    market: "crypto",
    initial: 10000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: ["BTC", "ETH"].map((symbol) => {
      const bars = dates.map((date, i) => ({
        date,
        open: 10,
        close: 10,
        high: 11,
        low: 9,
        volume: 1000,
        amount: 10000,
      }));
      return {
        symbol,
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          minimum: 0.001,
          step: 0.001,
          limitUp: null,
          limitDown: null,
          tradable: true,
        },
      };
    }),
    strategies: [
      {
        id: "test",
        version: 1,
        market: "crypto",
        period: "day",
        sleeve: "swing",
        universe: { kind: "symbols", symbols: ["BTC", "ETH"] },
        entry: { kind: "constant", value: true },
        exit: {},
        sizing: { kind: "equal", positions: 10 },
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 10 }],
    costs: {
      ...defaultExecutionCosts,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  };
}
describe("predeclared small-universe sizing", () => {
  it("expires a prior volatility weight at a missing daily close and blocks new entry until 60 complete returns exist again", () => {
    const q = request();
    q.instruments = q.instruments.map((i) => ({
      ...i,
      bars: i.bars.filter((b) => b.date !== dates[62]),
      signalBars: i.signalBars.filter((b) => b.date !== dates[62]),
      external: {
        signals: [
          {
            id: "timing",
            date: dates[63]!,
            availableAt: dates[63]!,
            entry: true,
            exit: false,
          },
        ],
      },
    }));
    q.strategies = q.strategies.map((s) => ({
      ...s,
      entry: { kind: "external", id: "timing", side: "entry" },
    }));
    const sized = sizeCryptoResearch(q, "volatility");
    expect(
      sized
        .positionWeights!.filter((w) => w.date === dates[62])
        .map((w) => w.weight),
    ).toEqual([0, 0]);
    expect(runPortfolio(sized).fills).toEqual([]);
  });
  it("two assets use 50% each rather than ten slots and fill through the shared account", () => {
    const result = runPortfolio(sizeCryptoResearch(request(), "equal"));
    expect(result.fills.map((f) => f.quantity)).toEqual([500, 500]);
    expect(result.curve.at(-1)!.cash).toBe(0);
  });
  it("volatility weights need 60 prior daily returns and never borrow or exceed 1/N", () => {
    const q = sizeCryptoResearch(request(), "volatility");
    expect(q.positionWeights![0]!.date).toBe(dates[60]);
    expect(
      q.positionWeights!.every(
        (w) => w.weight >= 0 && w.weight <= 0.5 && w.availableAt <= w.date,
      ),
    ).toBe(true);
    const result = runPortfolio(q);
    expect(result.fills[0]!.signalAt).toBe(dates[60]);
    expect(result.fills.map((f) => f.quantity)).toEqual([500, 500]);
    const changed = request();
    changed.instruments[0]!.bars = changed.instruments[0]!.bars.map((b, i) =>
      i === 64 ? { ...b, close: 10.5 } : b,
    );
    const future = sizeCryptoResearch(changed, "volatility");
    expect(future.positionWeights!.filter((w) => w.date < dates[64]!)).toEqual(
      q.positionWeights!.filter((w) => w.date < dates[64]!),
    );
  });
});
