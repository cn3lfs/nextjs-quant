import { expect, it } from "vitest";
import type { PortfolioFill } from "quant-backtest";
import { economicFillList } from "~/lib/backtest/economic-fills";

const buy: PortfolioFill = {
  orderId: 1,
  strategyId: "main",
  sleeve: "swing",
  symbol: "sh600000",
  side: "buy",
  signalAt: "2026-01-05",
  date: "2026-01-06",
  price: 10,
  quantity: 100,
  fee: 5,
  cashAfter: 8995,
  holdingAfter: 100,
};
it("does not turn an unfilled-order counter or different reference quote into a testable neighbor", () => {
  const neighbor: PortfolioFill = {
    ...buy,
    orderId: 9,
    strategyId: "main-neighbor-entry-2",
    signalAt: "2026-01-04",
    executionEvidence: {
      intendedPrice: 9.99,
      slippageBps: 10,
      source: "portfolio-OHLC-model",
    },
  };
  expect(economicFillList([neighbor])).toEqual(economicFillList([buy]));
  expect(
    economicFillList(
      [{ ...neighbor, strategyId: "l3-main-n-entry-rank-90" }],
      "l3-main",
    ),
  ).toEqual(economicFillList([{ ...buy, strategyId: "l3-main" }]));
});
it("retains every actual cash or share difference and the economic fill sequence", () => {
  const original = economicFillList([buy]);
  for (const difference of [
    { price: 10.01 },
    { quantity: 200 },
    { fee: 6 },
    { cashAfter: 8994 },
    { holdingAfter: 200 },
    { date: "2026-01-07" },
  ])
    expect(economicFillList([{ ...buy, ...difference }])).not.toEqual(original);
  const sell: PortfolioFill = {
    ...buy,
    orderId: 2,
    side: "sell",
    date: "2026-01-07",
    cashAfter: 9990,
    holdingAfter: 0,
  };
  expect(economicFillList([buy, sell])).not.toEqual(
    economicFillList([sell, buy]),
  );
  expect(() => economicFillList([{ ...buy, fee: NaN }])).toThrow("Nonfinite");
});
