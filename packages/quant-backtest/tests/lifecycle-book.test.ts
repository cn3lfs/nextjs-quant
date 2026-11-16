import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";
const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
const bars = dates.map((date) => ({
  date,
  open: 10,
  high: 11,
  low: 9,
  close: 10,
  volume: 1000,
  amount: 10000,
}));
const strategy = (id: string, symbol: string) => ({
  id,
  version: 1,
  market: "cn-equity" as const,
  period: "day" as const,
  universe: { kind: "symbols" as const, symbols: [symbol] },
  entry: { kind: "constant" as const, value: true },
  exit: {},
  sizing: { kind: "weight" as const, weight: 1 },
  sleeve: "swing",
  rank: { kind: "rps-composite" as const, periods: [20] },
});
function request(): PortfolioRequest {
  return {
    market: "cn-equity",
    initial: 100000,
    start: dates[0]!,
    end: dates[3]!,
    calendar: dates,
    strategies: [strategy("alpha", "sh600000"), strategy("beta", "sh600001")],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    instruments: ["sh600000", "sh600001"].map((symbol, i) => ({
      symbol,
      market: "cn-equity",
      bars,
      signalBars: bars,
      execution: {
        evidence: "fixed fixture",
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
      external: {
        rps: dates.map((date) => ({
          date,
          periods: [20],
          values: [{ return: 1, rank: 1, rps: i ? 90 : 10 }],
        })),
      },
    })),
  };
}
it("scarce slots fill by cross-sectional rank, not alphabetic symbol or strategy order", () => {
  const result = runPortfolio(request());
  expect(result.fills[0]?.symbol).toBe("sh600001");
  expect(result.positions.map((p) => p.symbol)).toEqual(["sh600001"]);
  expect(result.fills[0]?.executionEvidence).toEqual({
    intendedPrice: 10,
    slippageBps: 0,
    source: "portfolio-OHLC-model",
  });
});
it("weekly target orders retain real rank when the hard sleeve slot limit is lower than top-N", () => {
  const q = request(),
    calendar = ["2026-01-09", "2026-01-12"];
  q.start = calendar[0]!;
  q.end = calendar[1]!;
  q.calendar = calendar;
  q.strategies = [
    {
      ...strategy("weekly", "sh600000"),
      universe: { kind: "symbols", symbols: ["sh600000", "sh600001"] },
      rebalance: {
        kind: "ranked-weekly",
        top: 2,
        retentionMultiple: 1.5,
        weighting: "equal",
      },
    },
  ];
  q.instruments = q.instruments.map((s, i) => {
    const rows = calendar.map((date) => ({
      ...bars[0]!,
      date,
      high: 10.1,
      low: 9.9,
    }));
    return {
      ...s,
      bars: rows,
      signalBars: rows,
      external: {
        rps: calendar.map((date) => ({
          date,
          periods: [20],
          values: [{ return: 0.1, rank: i ? 1 : 2, rps: i ? 90 : 10 }],
        })),
      },
    };
  });
  const result = runPortfolio(q);
  expect(
    result.fills.filter((f) => f.side === "buy").map((f) => f.symbol),
  ).toEqual(["sh600001"]);
  expect(result.orders.find((o) => o.symbol === "sh600001")?.rankScore).toBe(
    0.9,
  );
  expect(result.orders.find((o) => o.symbol === "sh600000")?.rankScore).toBe(
    0.1,
  );
});
it("time exits with a required reset cannot repeatedly re-enter a permanently true condition", () => {
  const q = request();
  q.strategies = [
    {
      ...q.strategies[0]!,
      rank: undefined,
      exit: {
        maxBars: 1,
        timeReentry: { cooldownBars: 1, requireNewSignal: true },
      },
    },
  ];
  q.sleeves[0]!.maxPositions = 2;
  const result = runPortfolio(q);
  expect(result.fills.filter((f) => f.side === "buy")).toHaveLength(1);
  expect(result.fills.filter((f) => f.side === "sell")).toHaveLength(1);
});
it("legacy requests keep their fill payload shape and do not acquire lifecycle projections", () => {
  const q = request();
  q.strategies = [{ ...q.strategies[0]!, rank: undefined }];
  const result = runPortfolio(q);
  expect(result.fills[0]).not.toHaveProperty("executionEvidence");
  expect(result).not.toHaveProperty("bookDecisions");
});
it("same-symbol strategies share actual heat and symbol caps without managing each other's positions", () => {
  const q = request();
  q.strategies = ["alpha", "beta"].map((id) => ({
    ...strategy(id, "sh600000"),
    exit: { stop: { kind: "fixed", fraction: 0.1 } },
    overlay: { symbolWeight: 0.15, heat: 0.012 },
    sizing: { kind: "weight", weight: 0.08 },
  }));
  const calm = bars.map((b) => ({ ...b, high: 10.1, low: 9.9 }));
  q.instruments = [{ ...q.instruments[0]!, bars: calm, signalBars: calm }];
  const result = runPortfolio(q);
  expect(
    result.fills
      .filter((f) => f.side === "buy")
      .map((f) => [f.strategyId, f.quantity]),
  ).toEqual([
    ["alpha", 800],
    ["beta", 400],
  ]);
  expect(result.positions.map((p) => [p.strategyId, p.quantity])).toEqual([
    ["alpha", 800],
    ["beta", 400],
  ]);
  expect(result.fills.filter((f) => f.side === "sell")).toEqual([]);
  expect(
    (result.positions.reduce((n, p) => n + p.quantity, 0) * (10 - 9)) / 100000,
  ).toBe(0.012);
});
it("every shared-sleeve book sees all completed closes regardless of strategy iteration order", () => {
  const q = request();
  q.sleeves[0]!.maxPositions = 2;
  q.strategies = q.strategies.map((s) => ({
    ...s,
    overlay: { symbolWeight: 1 },
    sizing: { kind: "weight", weight: 0.08 },
  }));
  q.instruments = q.instruments.map((s, i) => {
    const rows = bars.map((b) => {
      const close = i && b.date >= dates[2]! ? 20 : 10;
      return { ...b, high: close + 0.1, low: 9.9, close };
    });
    return { ...s, bars: rows, signalBars: rows };
  });
  const result = runPortfolio(q),
    reversed = runPortfolio({ ...q, strategies: [...q.strategies].reverse() });
  const equity = (r: typeof result) =>
    r
      .bookDecisions!.filter((b) => b.decision.date === dates[2])
      .map((b) => [b.strategyId, b.decision.state.overlay!.previousEquity])
      .sort();
  expect(equity(result)).toEqual([
    ["alpha", 108000],
    ["beta", 108000],
  ]);
  expect(equity(reversed)).toEqual(equity(result));
});
