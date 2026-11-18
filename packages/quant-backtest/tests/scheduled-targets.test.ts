import { describe, expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";

const dates = [
  "2020-12-30",
  "2020-12-31",
  "2021-12-29",
  "2021-12-30",
  "2021-12-31",
  "2022-01-04",
];
const hash = "a".repeat(64);
function request(): PortfolioRequest {
  return {
    market: "cn-equity",
    initial: 100000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    strategies: [
      {
        id: "annual",
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: {
          kind: "symbols",
          symbols: ["sh600000", "sh600001", "sh600002"],
        },
        entry: { kind: "constant", value: false },
        exit: { rule: { kind: "constant", value: false } },
        sizing: { kind: "weight", weight: 0.1 },
        sleeve: "annual",
      },
    ],
    sleeves: [{ id: "annual", share: 1, riskPerTrade: 1, maxPositions: 3 }],
    costs: {
      version: "cost-experiment-1",
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
    instruments: [10, 20, 25].map((price, i) => {
      const bars = dates.map((date) => ({
        date,
        open: price,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 1000000,
        amount: price * 1000000,
      }));
      return {
        symbol: `sh60000${i}`,
        market: "cn-equity",
        bars,
        signalBars: bars,
        execution: {
          minimum: 100,
          step: 100,
          maximum: 10000000,
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
        },
      };
    }),
    scheduledTargets: [
      {
        strategyId: "annual",
        date: dates[0]!,
        availableAt: dates[0]!,
        sourceHash: hash,
        targets: { sh600000: 0.6, sh600001: 0.4 },
      },
      {
        strategyId: "annual",
        date: dates[3]!,
        availableAt: dates[3]!,
        sourceHash: "b".repeat(64),
        targets: { sh600000: 0.2, sh600002: 0.8 },
      },
    ],
  };
}

describe("scheduled completed-day portfolio targets", () => {
  it("rebalances two annual snapshots with sales before buys and liquidates omitted holdings", () => {
    const result = runPortfolio(request());
    expect(
      result.fills.map((f) => [f.date, f.symbol, f.side, f.quantity]),
    ).toEqual([
      [dates[1], "sh600000", "buy", 6000],
      [dates[1], "sh600001", "buy", 2000],
      [dates[4], "sh600000", "sell", 4000],
      [dates[4], "sh600001", "sell", 2000],
      [dates[4], "sh600002", "buy", 3200],
    ]);
    expect(result.positions.map((p) => [p.symbol, p.quantity])).toEqual([
      ["sh600000", 2000],
      ["sh600002", 3200],
    ]);
    expect(result.orders.every((o) => o.targetSourceHash?.length === 64)).toBe(
      true,
    );
    expect(
      result.curve.every((row) => row.cash >= 0 && row.equity === 100000),
    ).toBe(true);
    expect(result.fills.every((f) => f.date > f.signalAt)).toBe(true);
  });
  it("keeps existing strategies identical when scheduled targets are omitted or empty", () => {
    const input = request();
    input.scheduledTargets = undefined;
    input.strategies = [
      { ...input.strategies[0]!, entry: { kind: "constant", value: true } },
    ];
    expect(runPortfolio({ ...input, scheduledTargets: [] })).toEqual(
      runPortfolio(input),
    );
  });
  it("uses existing lot sizes, commissions and cash ceilings rather than inventing fractional shares", () => {
    const input = request();
    input.initial = 12345;
    input.costs = {
      ...input.costs!,
      commissionBps: 10,
      minimumCommission: 5,
      sellTaxBps: 10,
    };
    const result = runPortfolio(input);
    expect(result.fills.length).toBeGreaterThan(2);
    expect(
      result.fills.every(
        (f) => f.quantity % 100 === 0 && f.cashAfter >= 0 && f.fee >= 5,
      ),
    ).toBe(true);
    expect(result.curve.every((row) => row.cash >= 0)).toBe(true);
    expect(result.curve.at(-1)!.equity).toBeLessThan(input.initial);
  });
  it("empty target liquidates all managed positions, leaving no new buy intents", () => {
    const input = request();
    input.scheduledTargets = [
      input.scheduledTargets![0]!,
      { ...input.scheduledTargets![1]!, targets: {} },
    ];
    const result = runPortfolio(input);
    expect(result.positions).toHaveLength(0);
    expect(
      result.fills
        .filter((f) => f.date === dates[4])
        .every((f) => f.side === "sell"),
    ).toBe(true);
  });
  it("replaces an old blocked sell at the next completed target without rewriting prior orders", () => {
    const input = request();
    input.scheduledTargets = [
      input.scheduledTargets![0]!,
      {
        strategyId: "annual",
        date: dates[2]!,
        availableAt: dates[2]!,
        sourceHash: hash,
        targets: {},
      },
      {
        strategyId: "annual",
        date: dates[3]!,
        availableAt: dates[3]!,
        sourceHash: hash,
        targets: { sh600000: 0.6, sh600001: 0.4 },
      },
    ];
    input.instruments = input.instruments.map((instrument) => ({
      ...instrument,
      execution: (bar) => ({
        minimum: 100,
        step: 100,
        maximum: 10000000,
        tradable: bar?.date !== dates[3],
        evidence: "fixture",
        limitUp: null,
        limitDown: null,
      }),
    }));
    const result = runPortfolio(input);
    expect(result.fills).toHaveLength(2);
    expect(result.orders.filter((o) => o.side === "sell")).toHaveLength(2);
    expect(
      result.orders
        .filter((o) => o.side === "sell")
        .every(
          (o) =>
            o.status === "rejected" &&
            o.attempts === 1 &&
            o.reason === "被新的完成bar调仓目标替代",
        ),
    ).toBe(true);
  });
  it("does not create a same-close or synthetic end-of-window fill", () => {
    const input = request();
    input.scheduledTargets = [
      {
        ...input.scheduledTargets![0]!,
        date: dates.at(-1)!,
        availableAt: dates.at(-1)!,
      },
    ];
    const result = runPortfolio(input);
    expect(result.fills).toHaveLength(0);
    expect(
      result.orders.every((o) => o.due === null && o.status === "pending"),
    ).toBe(true);
  });
  it("rejects duplicate events, future evidence, unknown symbols, invalid hashes and invalid weights", () => {
    const base = request().scheduledTargets![0]!;
    const changes: Partial<
      NonNullable<PortfolioRequest["scheduledTargets"]>[number]
    >[] = [
      { strategyId: "unknown" },
      { date: "2020-12-29" },
      { availableAt: "2021-01-01" },
      { availableAt: "invalid" },
      { sourceHash: "unchecked" },
      { targets: { sh999999: 0.1 } },
      { targets: { sh600000: -0.1 } },
      { targets: { sh600000: Number.NaN } },
      { targets: { sh600000: 0.6, sh600001: 0.5 } },
    ];
    for (const change of changes) {
      const input = request();
      input.scheduledTargets = [{ ...base, ...change }];
      expect(() => runPortfolio(input), JSON.stringify(change)).toThrow();
    }
    const input = request();
    input.scheduledTargets = [base, { ...base }];
    expect(() => runPortfolio(input)).toThrow("Duplicate scheduled target");
  });
  it("rejects competing entry policies and securities outside the strategy universe", () => {
    const input = request();
    input.strategies = [
      { ...input.strategies[0]!, entry: { kind: "constant", value: true } },
    ];
    expect(() => runPortfolio(input)).toThrow("exclusive");
    const outside = request();
    outside.strategies = [
      {
        ...outside.strategies[0]!,
        universe: { kind: "symbols", symbols: ["sh600000"] },
      },
    ];
    expect(() => runPortfolio(outside)).toThrow("symbols / weights");
  });
});
