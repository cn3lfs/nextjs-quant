import { expect, it } from "vitest";
import {
  atomsFrom,
  atomsText,
  ExecutionLedger,
  type CostRates,
  type ExecutionQuote,
} from "quant-execution";
import { PortfolioAccount } from "../src/portfolio-account.js";
import { portfolioExecutionFee } from "../src/portfolio-sizing.js";
import { defaultExecutionCosts } from "trading-strategy-core/costs";

const costs = {
  ...defaultExecutionCosts,
  commissionBps: 3,
  minimumCommission: 5,
  transferBps: 0.1,
  sellTaxBps: 5,
  slippageBps: 0,
};
const rates: CostRates = {
  commissionBps: 3,
  minimumCommission: atomsFrom("cn-equity", 5, "money"),
  transferBps: 0.1,
  sellTaxBps: 5,
  slippageBps: 0,
};
const quote = (date: string): ExecutionQuote => ({
  date,
  open: atomsFrom("cn-equity", 10, "price"),
  high: atomsFrom("cn-equity", 10.2, "price"),
  low: atomsFrom("cn-equity", 9.8, "price"),
  close: atomsFrom("cn-equity", 10, "price"),
  volume: atomsFrom("cn-equity", 1_000_000, "quantity"),
  tradable: true,
  limitUp: null,
  limitDown: null,
});

it("matches the legacy account for the shared buy/sell and fee subset", () => {
  const legacy = new PortfolioAccount(10_000);
  const buyFee = portfolioExecutionFee(100, 10, "buy", costs);
  legacy.fill("sh600000", "2026-01-05", "buy", 100, 10, buyFee, 1);
  const ledger = new ExecutionLedger(
    "cn-equity",
    atomsFrom("cn-equity", 10_000, "money"),
    rates,
  );
  ledger.submit({
    id: "buy",
    symbol: "sh600000",
    side: "buy",
    quantity: atomsFrom("cn-equity", 100, "quantity"),
  });
  ledger.matchOpen("2026-01-05", new Map([["sh600000", quote("2026-01-05")]]));
  expect(ledger.cash).toBe(
    atomsFrom("cn-equity", legacy.cash.toFixed(2), "money"),
  );
  expect(
    atomsText("cn-equity", ledger.snapshot().positions[0]!.quantity, "quantity"),
  ).toBe("100");

  const sellFee = portfolioExecutionFee(100, 10, "sell", costs);
  legacy.fill("sh600000", "2026-01-06", "sell", 100, 10, sellFee, 1);
  ledger.submit({
    id: "sell",
    symbol: "sh600000",
    side: "sell",
    quantity: atomsFrom("cn-equity", 100, "quantity"),
  });
  ledger.matchOpen("2026-01-06", new Map([["sh600000", quote("2026-01-06")]]));
  expect(ledger.cash).toBe(
    atomsFrom("cn-equity", legacy.cash.toFixed(2), "money"),
  );
  expect(ledger.snapshot().positions).toEqual([]);
});
