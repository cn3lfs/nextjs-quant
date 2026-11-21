import { expect, it, vi } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";
import * as preparation from "../src/portfolio/preparation.js";
import * as state from "../src/portfolio/state.js";

const { createPortfolioState } = state;

const dates = ["2026-01-05", "2026-01-06", "2026-01-07"] as const;
const symbols = ["sh600000", "sz000001"] as const;

function fixture(): PortfolioRequest {
  const bars = dates.map((date) => ({
    date,
    open: 10,
    close: 10,
    high: 11,
    low: 9,
    volume: 10000,
    amount: 100000,
  }));
  const strategy = {
    version: 1,
    market: "cn-equity",
    period: "day",
    entry: { kind: "constant", value: true },
    exit: {},
    sizing: { kind: "weight", weight: 0.1 },
    sleeve: "main",
  } as const;
  return {
    market: "cn-equity",
    initial: 100000,
    start: dates[0],
    end: dates[2],
    calendar: dates,
    strategies: [
      {
        ...strategy,
        id: "rps",
        universe: { kind: "rps", period: 5, minimum: 80 },
      },
      { ...strategy, id: "pool", universe: { kind: "pool", id: "pit" } },
    ],
    sleeves: [{ id: "main", share: 1, riskPerTrade: 1, maxPositions: 2 }],
    instruments: symbols.map((symbol, i) => ({
      symbol,
      market: "cn-equity",
      bars,
      signalBars: bars,
      execution: {
        evidence: "fixture",
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
      external: {
        rps: [
          {
            date: dates[0],
            periods: [10, 5],
            values: [null, { return: 0.1, rank: 1, rps: i === 0 ? 80 : 30 }],
          },
          {
            date: dates[1],
            periods: [10],
            values: [{ return: 0.2, rank: 1, rps: 90 }],
          },
        ],
      },
    })),
    memberships: dates.map((date, i) => ({
      date,
      strategyId: "pool",
      availableAt: date,
      symbols: i === 1 ? [] : [symbols[1]],
    })),
  };
}

function scanEligibility(
  request: PortfolioRequest,
): state.PortfolioState["eligibleAt"] {
  return (strategy, symbol, source, date) => {
    const universe = strategy.universe;
    if (universe.kind === "rps") {
      const point = source.instrument.external?.rps?.find(
        (p) => p.date === date,
      );
      const value = point?.values[point.periods.indexOf(universe.period)]?.rps;
      return value != null && value >= universe.minimum;
    }
    const row = request.memberships!.find(
      (m) => m.date === date && m.strategyId === strategy.id,
    );
    return row!.symbols.includes(symbol);
  };
}

function expectEligibilityToMatchFind(request: PortfolioRequest) {
  const { calendar, strategies, instruments, eligibleAt } =
    createPortfolioState(request);
  const scan = scanEligibility(request);
  for (const strategy of strategies)
    for (const date of calendar)
      for (const [symbol, source] of instruments)
        expect(eligibleAt(strategy, symbol, source, date)).toBe(
          scan(strategy, symbol, source, date),
        );
}

it("matches the original scan for RPS periods and PIT membership on every bar", () => {
  const request = fixture();
  expectEligibilityToMatchFind(request);
  const indexed = runPortfolio(request);
  expect(
    indexed.fills.map(({ strategyId, symbol }) => [strategyId, symbol]),
  ).toEqual([
    ["rps", symbols[0]],
    ["pool", symbols[1]],
  ]);
  const create = vi
    .spyOn(state, "createPortfolioState")
    .mockImplementationOnce((input) => ({
      ...createPortfolioState(input),
      eligibleAt: scanEligibility(input),
    }));
  try {
    expect(runPortfolio(request)).toEqual(indexed);
  } finally {
    create.mockRestore();
  }
});

it("keeps the first RPS point and first membership row at the lookup boundary", () => {
  const valid = fixture();
  const prepared = preparation.preparePortfolioRequest(valid);
  const instruments = valid.instruments.map((instrument, i) => ({
    ...instrument,
    external: {
      rps: [
        ...instrument.external!.rps!,
        {
          date: dates[0],
          periods: [5],
          values: [{ return: 0.2, rank: 1, rps: i === 0 ? 30 : 90 }],
        },
      ],
    },
  }));
  const memberships = [
    ...valid.memberships!,
    {
      strategyId: "pool",
      date: dates[1],
      availableAt: dates[1],
      symbols: [symbols[0]],
    },
  ];
  expect(() => createPortfolioState({ ...valid, instruments })).toThrow(
    "Duplicate RPS observations",
  );
  expect(() => createPortfolioState({ ...valid, memberships })).toThrow(
    "Duplicate PIT membership",
  );

  // Exercise lookup independently of the real request validators above.
  for (const instrument of instruments) {
    const source = prepared.instruments.get(instrument.symbol)!;
    prepared.instruments.set(instrument.symbol, { ...source, instrument });
  }
  const prepare = vi
    .spyOn(preparation, "preparePortfolioRequest")
    .mockReturnValueOnce(prepared);
  try {
    expectEligibilityToMatchFind({ ...valid, instruments, memberships });
  } finally {
    prepare.mockRestore();
  }
});

it("throws the original missing PIT membership error when the strategy has no row for that date", () => {
  const request = fixture();
  const memberships = request.memberships!.filter(
    (row) => row.date !== dates[1],
  );
  expect(() => runPortfolio({ ...request, memberships })).toThrow(
    "Missing PIT universe membership",
  );
});
