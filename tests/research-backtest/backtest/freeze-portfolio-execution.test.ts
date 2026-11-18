import { expect, it } from "vitest";
import { freezePortfolioExecution } from "~/server/research/freeze-portfolio-execution";
import {
  runPortfolio,
  type PortfolioInstrument,
  type PortfolioRequest,
} from "quant-backtest";

it("exports replayable execution facts without inventing missing evidence", () => {
  const bars = ["2026-10-12", "2026-10-13", "2026-10-14"].map((date) => ({
    date,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100000,
    amount: 1000000,
  }));
  const instrument: PortfolioInstrument = {
    symbol: "sh600000",
    market: "cn-equity",
    bars,
    signalBars: bars,
    execution: (bar, previous) =>
      previous && bar
        ? {
            evidence: "frozen daily price limits",
            minimum: 100,
            step: 100,
            limitUp: previous.close * 1.1,
            limitDown: previous.close * 0.9,
            tradable: true,
          }
        : undefined,
  };
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 1000000,
    start: bars[0]!.date,
    end: bars[2]!.date,
    calendar: bars.map((bar) => bar.date),
    instruments: [instrument],
    strategies: [
      {
        id: "freeze-test",
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: { kind: "symbols", symbols: ["sh600000"] },
        entry: { kind: "constant", value: true },
        exit: {},
        sizing: { kind: "weight", weight: 0.1 },
        sleeve: "swing",
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.01, maxPositions: 1 }],
  };
  const frozen = freezePortfolioExecution(instrument);
  expect(frozen.execution).not.toHaveProperty(bars[0]!.date);
  expect(frozen.execution).toHaveProperty(bars[1]!.date);
  const replay = JSON.parse(
    JSON.stringify({ ...request, instruments: [frozen] }),
  ) as PortfolioRequest;
  const direct = runPortfolio(request);
  expect(direct.fills.length).toBeGreaterThan(0);
  expect(runPortfolio(replay)).toEqual(direct);
});
