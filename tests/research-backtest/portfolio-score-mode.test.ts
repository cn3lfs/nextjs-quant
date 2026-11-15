import { expect, it } from "vitest";
import {
  createPortfolioPreparation,
  runPortfolio,
  type PortfolioExecution,
  type PortfolioRequest,
} from "quant-backtest";
import { defaultExecutionCosts } from "trading-strategy-core/costs";
import { scoreBookSleeves } from "../../scripts/lib/research-book-sleeves";
const dates = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
);
const bars = dates.map((date, i) => ({
  date,
  open: 10 + i * 0.1,
  close: 10.05 + i * 0.1,
  high: 10.2 + i * 0.1,
  low: 9.9 + i * 0.1,
  volume: 1000,
  amount: 10000,
}));
function input(): PortfolioRequest {
  return {
    market: "crypto",
    initial: 10000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [
      {
        symbol: "BTC",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixed test",
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
        id: "score",
        version: 1,
        market: "crypto",
        period: "day",
        sleeve: "swing",
        universe: { kind: "symbols", symbols: ["BTC"] },
        entry: { kind: "constant", value: true },
        exit: { maxBars: 3 },
        sizing: { kind: "weight", weight: 0.5 },
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: defaultExecutionCosts,
  };
}
it("filters aggregate observation counts by sleeve with the same sleeve scores", () => {
  const one = input();
  const q: PortfolioRequest = {
    ...one,
    strategies: [
      one.strategies[0]!,
      {
        ...one.strategies[0]!,
        id: "second",
        sleeve: "breakout",
        entry: { kind: "constant", value: false },
      },
    ],
    sleeves: [
      { ...one.sleeves[0]!, share: 0.75 },
      { ...one.sleeves[0]!, id: "breakout", share: 0.25 },
    ],
  };
  const dataset = {
    period: "day" as const,
    instruments: q.instruments.map((i) => ({ ...i })),
    sources: [],
    benchmark: bars,
    dates,
    benchmarkName: "fixed",
  };
  expect(
    scoreBookSleeves(
      runPortfolio({ ...q, observationDetail: "counts" }),
      q,
      dataset,
    ),
  ).toEqual(scoreBookSleeves(runPortfolio(q), q, dataset));
});
it("retains every fill, cash, rejection and equity value when replacing no-op observations with exact counts", () => {
  const q = input();
  const full = runPortfolio(q),
    compact = runPortfolio({ ...q, observationDetail: "counts" });
  const { observations, ...financial } = full;
  const {
    observations: omitted,
    observationCounts,
    ...compactFinancial
  } = compact;
  expect(compactFinancial).toEqual(financial);
  expect(omitted).toEqual([]);
  expect(observationCounts).toEqual({
    score: {
      entries: observations.filter((o) => o.decision.entry === true).length,
      exits: observations.filter((o) => o.decision.exit === true).length,
    },
  });
  expect(observations).toHaveLength(12);
});
it("reuses only pure preparation while each stress starts independent cash and holdings", () => {
  const q = input(),
    cache = createPortfolioPreparation();
  const original = JSON.stringify(q);
  const doubled = {
    ...q,
    costs: {
      ...defaultExecutionCosts,
      commissionBps: defaultExecutionCosts.commissionBps * 2,
      slippageBps: defaultExecutionCosts.slippageBps * 2,
    },
  };
  const delayed = { ...q, signalDelayBars: 1 as const };
  for (const request of [q, doubled, delayed, q])
    expect(runPortfolio(request, undefined, cache)).toEqual(
      runPortfolio(request),
    );
  expect(runPortfolio(delayed).fills[0]!.date).not.toBe(
    runPortfolio(q).fills[0]!.date,
  );
  expect(JSON.stringify(q)).toBe(original);
});
it("resolves execution constraints only on attempted orders with identical financial results", () => {
  const q = input();
  const fixed = q.instruments[0]!.execution;
  if (typeof fixed === "function" || !("evidence" in fixed))
    throw new Error("fixture");
  let calls = 0;
  const lazy = {
    ...q,
    instruments: q.instruments.map((i) => ({
      ...i,
      execution: (
        bar: (typeof bars)[number] | undefined,
        previous: (typeof bars)[number] | undefined,
      ) => {
        calls++;
        if (bar)
          expect(previous?.date).toBe(
            bars[bars.findIndex((b) => b.date === bar.date) - 1]?.date,
          );
        return fixed as PortfolioExecution;
      },
    })),
  };
  const actual = runPortfolio(lazy);
  expect(actual).toEqual(runPortfolio(q));
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThan(bars.length);
});
