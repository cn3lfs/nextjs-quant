import { expect, it } from "vitest";
import { backtest } from "../src/server/quant";
import { defaultBacktestCosts } from "../src/lib/backtest-costs";
import { defaultStrategy } from "../src/lib/domain";
const bars = [10, 11, 12, 13, 14, 15, 9, 8, 7].map((price, index) => ({
  date: `2025-01-${String(index + 1).padStart(2, "0")}`,
  open: price,
  high: price + 1,
  low: price - 1,
  close: price,
  volume: 10000,
  amount: price * 10000,
}));
const strategy = {
  ...defaultStrategy,
  fast: 2,
  slow: 3,
  minChange: -30,
  maxChange: 30,
};
it("cost parameters affect actual fills and fees and are frozen into the result", () => {
  const costs = {
    ...defaultBacktestCosts,
    commissionBps: 10,
    minimumCommission: 2,
    sellTaxBps: 20,
    slippageBps: 100,
  };
  const result = backtest(bars, strategy, "snapshot", 10000, costs);
  expect(result.trades).toHaveLength(2);
  expect(result.trades[0]?.price).toBeCloseTo(14.14, 10);
  expect(result.trades[0]?.shares).toBe(700);
  expect(result.trades[0]?.fee).toBeCloseTo(9.898, 10);
  expect(result.trades[1]?.price).toBeCloseTo(7.92, 10);
  expect(result.trades[1]?.fee).toBeCloseTo(16.632, 10);
  expect(result.cash).toBeGreaterThanOrEqual(0);
  expect(result.costs).toEqual(costs);
  costs.commissionBps = 99;
  expect(result.costs?.commissionBps).toBe(10);
  expect(result.engineVersion).toBe("backtest-3");
});
it("zero-cost control, minimum commission and invalid input have distinct behavior", () => {
  const free = backtest(bars, strategy, "s", 10000, {
    ...defaultBacktestCosts,
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  });
  expect(free.trades.map((trade) => trade.fee)).toEqual([0, 0]);
  expect(free.trades[0]?.price).toBe(14);
  const minimum = backtest(bars, strategy, "s", 10000, {
    ...defaultBacktestCosts,
    commissionBps: 0,
    minimumCommission: 100,
    sellTaxBps: 0,
  });
  expect(minimum.trades.map((trade) => trade.fee)).toEqual([100, 100]);
  for (const bad of [-1, Infinity, NaN, 1001])
    expect(() =>
      backtest(bars, strategy, "s", 10000, {
        ...defaultBacktestCosts,
        slippageBps: bad,
      }),
    ).toThrow();
});
it("buy-hold uses the evaluation window, costs and lot size with no terminal sale", () => {
  const costs = {
    ...defaultBacktestCosts,
    commissionBps: 0,
    minimumCommission: 5,
    slippageBps: 0,
    sellTaxBps: 500,
  };
  const result = backtest(bars, strategy, "s", 10000, costs, 4);
  const b = result.benchmark!;
  expect(b.trade).toEqual({
    date: bars[4]!.date,
    side: "buy",
    price: 14,
    shares: 700,
    fee: 5,
  });
  expect(b.cash).toBe(195);
  expect(b.shares).toBe(700);
  expect(b.equity.map((r) => r.date)).toEqual(result.equity.map((r) => r.date));
  expect(b.equity.at(-1)!.value).toBe(5095);
  expect(b.totalReturn).toBeCloseTo(-49.05);
  expect(b.maxDrawdown).toBeCloseTo(((10695 - 5095) / 10695) * 100);
  expect(b.excessReturnPoints).toBeCloseTo(result.totalReturn - b.totalReturn);
  const altered = structuredClone(bars);
  altered[0]!.open = 1000;
  expect(backtest(altered, strategy, "s", 10000, costs, 4).benchmark).toEqual(
    b,
  );
});
it("buy-hold waits past unavailable bars and stays in cash when no lot is affordable", () => {
  const unavailable = structuredClone(bars);
  unavailable[3]!.volume = 0;
  unavailable[4]!.high = unavailable[4]!.low;
  const result = backtest(unavailable, strategy, "s", 10000);
  expect(result.benchmark!.trade!.date).toBe(bars[5]!.date);
  expect(result.benchmark!.equity.slice(0, 2).map((r) => r.value)).toEqual([
    10000, 10000,
  ]);
  const cash = backtest(bars, strategy, "s", 100);
  expect(cash.benchmark).toMatchObject({
    trade: null,
    cash: 100,
    shares: 0,
    totalReturn: 0,
    maxDrawdown: 0,
  });
});
