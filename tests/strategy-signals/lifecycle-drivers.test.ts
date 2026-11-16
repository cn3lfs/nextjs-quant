import { expect, it } from "vitest";
import { executionCostsSchema } from "trading-strategy-core/costs";
import type { PortfolioRequest } from "quant-backtest";
import type { StrategyObjectInput } from "trading-strategies";
import { scanStrategy } from "~/server/strategies/drivers/scan";
import { watchStrategy } from "~/server/strategies/drivers/watch";
import {
  paperStrategy,
  runPaperPortfolio,
} from "~/server/strategies/drivers/paper";
import { backtestStrategy } from "~/server/strategies/drivers/backtest";
import { evaluateDriverBook } from "~/server/strategies/drivers/book";

it("all four drivers share a real weekly name replacement, including sell and incremental target intents", () => {
  const calendar = Array.from({ length: 15 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5 + i)).toISOString().slice(0, 10),
  ).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
  const symbols = ["sh600000", "sh600001", "sh600002"];
  const strategy: StrategyObjectInput = {
    id: "weekly-delta-fixture",
    version: 1,
    market: "cn-equity",
    period: "day",
    sleeve: "swing",
    universe: { kind: "symbols", symbols },
    entry: { kind: "constant", value: true },
    exit: { stop: { kind: "fixed", fraction: 0.08 } },
    sizing: { kind: "weight", weight: 1 },
    rank: { kind: "rps-composite", periods: [20] },
    rebalance: {
      kind: "ranked-weekly",
      top: 1,
      retentionMultiple: 1.5,
      weighting: "equal",
    },
  };
  const universe = symbols.map((symbol, i) => ({
    symbol,
    market: "cn-equity" as const,
    bars: calendar.map((date) => ({
      date,
      open: 10,
      high: 10.1,
      low: 9.9,
      close: 10,
      volume: 10000,
      amount: 100000,
    })),
    external: {
      rps: calendar.map((date) => ({
        date,
        periods: [20],
        values: [
          {
            return: 0.1,
            rank: 1,
            rps: date < "2026-01-16" ? 90 - i * 10 : [70, 80, 95][i]!,
          },
        ],
      })),
    },
  }));
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 100000,
    start: calendar[0]!,
    end: calendar.at(-1)!,
    calendar,
    strategies: [strategy],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    costs: executionCostsSchema.parse({
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    }),
    instruments: universe.map((s) => ({
      ...s,
      signalBars: s.bars,
      execution: {
        evidence: "fixed raw fixture",
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    })),
  };
  const result = backtestStrategy(request);
  expect(runPaperPortfolio(request)).toEqual(result);
  const first = result.bookDecisions!.find(
    (b) => b.decision.date === "2026-01-09",
  )!.decision;
  const admission = evaluateDriverBook(strategy, universe, "2026-01-16", {
    calendar,
    equity: 100000,
    initial: 100000,
    maxPositions: 1,
    state: first.state,
    holdings: [
      { symbol: symbols[0]!, weight: 0.15, openRisk: 0.012, managed: true },
    ],
    reentries: {},
  });
  const replay = result.bookDecisions!.find(
    (b) => b.decision.date === "2026-01-16",
  )!.decision;
  expect(admission.decision.targets).toEqual(replay.targets);
  expect(admission.decision.adjustments).toEqual(replay.adjustments);
  expect(
    scanStrategy(strategy, universe, "2026-01-16", { admission }).map(
      (c) => c.symbol,
    ),
  ).toEqual([symbols[2]]);
  expect(
    watchStrategy(strategy, universe[0]!, "2026-01-16", { admission }),
  ).toMatchObject([{ type: "exit", targetWeight: 0 }]);
  expect(
    watchStrategy(strategy, universe[2]!, "2026-01-16", { admission }),
  ).toMatchObject([{ type: "entry", targetWeight: 0.15 }]);
  expect(
    paperStrategy(strategy, universe[0]!, "2026-01-16", { admission }),
  ).toMatchObject([{ side: "SELL", targetWeight: 0 }]);
  expect(
    result.fills
      .filter((f) => f.date === "2026-01-19")
      .map((f) => [f.symbol, f.side, f.quantity]),
  ).toEqual([
    [symbols[0], "sell", 1500],
    [symbols[2], "buy", 1500],
  ]);
  expect(() => scanStrategy(strategy, universe, "2026-01-16")).toThrow(
    "same-version, same-bar",
  );
  expect(() =>
    watchStrategy(strategy, universe[0]!, "2026-01-16", {
      admission: { ...admission, version: 99 },
    }),
  ).toThrow("same-version, same-bar");
  const increase = evaluateDriverBook(strategy, universe, "2026-01-09", {
    calendar,
    equity: 100000,
    initial: 100000,
    maxPositions: 1,
    holdings: [{ symbol: symbols[0]!, weight: 0.08, openRisk: 0.0064 }],
    reentries: {},
  });
  const increment = scanStrategy(strategy, universe, "2026-01-09", {
    admission: increase,
    capital: {
      equity: 100000,
      cash: 92000,
      riskPerTrade: 1,
      existing: { quantity: 800, cost: 10, stop: 9.2 },
      costs: request.costs!,
    },
  });
  expect(increment[0]!.quantity).toBe(700);
  const held = {
    quantity: 800,
    stop: 9.2,
    target: null,
    high: 10,
    bars: 3,
    tranches: 1,
  };
  expect(
    watchStrategy(strategy, universe[0]!, "2026-01-09", {
      admission: increase,
      position: held,
    }),
  ).toMatchObject([{ type: "entry", targetWeight: 0.15 }]);
  expect(
    paperStrategy(strategy, universe[0]!, "2026-01-09", {
      admission: increase,
      position: held,
    }),
  ).toMatchObject([{ side: "BUY", targetWeight: 0.15 }]);
  const seeded = backtestStrategy({
    ...request,
    start: "2026-01-12",
    bookSeeds: [
      {
        strategyId: strategy.id,
        date: "2026-01-09",
        availableAt: "2026-01-09",
      },
    ],
  });
  expect(seeded.curve[0]!.date).toBe("2026-01-12");
  expect(seeded.fills[0]).toMatchObject({
    signalAt: "2026-01-09",
    date: "2026-01-12",
    quantity: 1500,
  });
  expect(seeded.bookDecisions![0]!.decision.targets).toEqual(first.targets);
  const laterSegment = backtestStrategy({
    ...request,
    start: "2026-01-19",
    bookSeeds: [
      {
        strategyId: strategy.id,
        date: "2026-01-16",
        availableAt: "2026-01-16",
        selectionFrom: "2026-01-09",
      },
    ],
  });
  expect(laterSegment.curve).toHaveLength(1);
  expect(laterSegment.fills).toMatchObject([
    {
      symbol: symbols[2],
      signalAt: "2026-01-16",
      date: "2026-01-19",
      quantity: 1500,
    },
  ]);
  expect(laterSegment.curve[0]!.equity).toBe(100000);
  const future = {
    ...universe[0]!,
    symbol: "sh600003",
    bars: universe[0]!.bars.filter((b) => b.date > "2026-01-16"),
  };
  const expanded = {
    ...strategy,
    universe: {
      kind: "symbols" as const,
      symbols: [...symbols, future.symbol],
    },
  };
  const context = {
    calendar,
    equity: 100000,
    initial: 100000,
    maxPositions: 1,
    holdings: [],
    reentries: {},
  };
  expect(
    evaluateDriverBook(expanded, [...universe, future], "2026-01-16", context)
      .decision.available,
  ).toBe(true);
  const hole = universe.map((s, i) =>
    i ? s : { ...s, bars: s.bars.filter((b) => b.date !== "2026-01-16") },
  );
  expect(
    evaluateDriverBook(strategy, hole, "2026-01-16", context).decision,
  ).toMatchObject({
    available: false,
    targets: null,
    reason: expect.stringContaining("completed-bar"),
  });
});
