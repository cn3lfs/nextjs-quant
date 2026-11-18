import { expect, it } from "vitest";
import { PortfolioAccount } from "../src/portfolio-account.js";
import { runPortfolio, type PortfolioRequest } from "../src/index.js";

it("uses exact entitlement instants across UTC/Shanghai labels while retaining default T+1", () => {
  const a = new PortfolioAccount(10000);
  a.fill("stock", "2026-11-16T01:40:00Z", "buy", 100, 10, 0, 1);
  a.corporateAction(
    "stock",
    {
      date: "2026-11-17T09:35:00+08:00",
      availableAt: "2026-11-17T09:35:00+08:00",
      dividend: 0,
      bonus: 0.1,
      evidence: "fixture",
      sharesSellableAt: "2026-11-17T11:00:00+08:00",
    },
    true,
  );
  expect(a.sellable("stock", "2026-11-17T02:59:00Z", 1)).toBe(100);
  expect(a.sellable("stock", "2026-11-17T03:00:00Z", 1)).toBe(110);
  a.fill("stock", "2026-11-17T03:00:00Z", "sell", 110, 10, 0, 1);
  expect(a.positions.size).toBe(0);
});

it("date-only entitlement is available by local trading day and daily replay stays unchanged", () => {
  const a = new PortfolioAccount(10000);
  a.fill("stock", "2026-11-16", "buy", 100, 10, 0, 1);
  a.positions.get("stock")!.lots[0]!.availableOn = "2026-11-17";
  expect(a.sellable("stock", "2026-11-16T16:01:00Z", 1)).toBe(100);
  expect(a.sellable("stock", "2026-11-16", 1)).toBe(0);
  expect(a.sellable("stock", "2026-11-17", 1)).toBe(100);
  const b = new PortfolioAccount(10000);
  b.fill("stock", "2026-11-16T23:30:00+08:00", "buy", 100, 10, 0, 1);
  expect(b.sellable("stock", "2026-11-16T15:59:00Z", 1)).toBe(0);
  expect(b.sellable("stock", "2026-11-16T16:01:00Z", 1)).toBe(100);
});

it("portfolio sells ex-date bonus shares at an eligible intraday open instead of stranding them until tomorrow", () => {
  const dates = [
    "2026-11-16T09:35:00+08:00",
    "2026-11-16T09:40:00+08:00",
    "2026-11-17T09:35:00+08:00",
    "2026-11-17T09:40:00+08:00",
  ];
  const bars = dates.map((date) => ({
    date,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100000,
    amount: 1000000,
  }));
  const input: PortfolioRequest = {
    market: "cn-equity",
    initial: 10000,
    start: dates[0]!,
    end: dates[3]!,
    calendar: dates,
    strategies: [
      {
        id: "bonus",
        version: 1,
        market: "cn-equity",
        period: "5m",
        universe: { kind: "symbols", symbols: ["sh600000"] },
        entry: { kind: "external", id: "fixture", side: "entry" },
        exit: { rule: { kind: "external", id: "fixture", side: "exit" } },
        sizing: { kind: "weight", weight: 1 },
        sleeve: "swing",
      },
    ],
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
        symbol: "sh600000",
        market: "cn-equity",
        bars,
        signalBars: bars,
        external: {
          signals: dates.map((date, i) => ({
            id: "fixture",
            date,
            availableAt: date,
            entry: i === 0,
            exit: i === 2,
          })),
        },
        actions: [
          {
            date: dates[2]!,
            availableAt: dates[2]!,
            sharesSellableAt: dates[2]!,
            dividend: 0,
            bonus: 0.1,
            evidence: "ex-date fixture",
          },
        ],
        execution: {
          minimum: 100,
          step: 100,
          maximum: 1000000,
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
  const result = runPortfolio(input);
  expect(result.fills.map((f) => [f.side, f.quantity, f.date])).toEqual([
    ["buy", 1000, dates[1]],
    ["sell", 1100, dates[3]],
  ]);
  expect(result.positions).toHaveLength(0);
});
