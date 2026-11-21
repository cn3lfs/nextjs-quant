import { postPortfolioFill } from "../src/portfolio/execution-ledger.js";
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
    atomsText(
      "cn-equity",
      ledger.snapshot().positions[0]!.quantity,
      "quantity",
    ),
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

it("reconciles each priced receipt, FIFO inventory, cash and marked equity", () => {
  const old = new PortfolioAccount(10000);
  const ledger = new ExecutionLedger("cn-equity", 1000000n, rates);
  const symbol = "sh600000";
  const receipts = [
    {
      date: "2026-01-05",
      side: "buy",
      quantity: 200,
      price: 10,
      commission: 5,
      transfer: 0.02,
      settledCashChange: -2005.02,
    },
    {
      date: "2026-01-06",
      side: "buy",
      quantity: 100,
      price: 12,
      commission: 5,
      transfer: 0.01,
      settledCashChange: -1205.01,
    },
    {
      date: "2026-01-06",
      side: "sell",
      quantity: 200,
      price: 11,
      commission: 5,
      transfer: 0.02,
      tax: 1.1,
      settledCashChange: 2193.88,
    },
    {
      date: "2026-01-07",
      side: "sell",
      quantity: 100,
      price: 9,
      commission: 5,
      transfer: 0.01,
      tax: 0.45,
      settledCashChange: 894.54,
    },
  ] as const;
  for (const [i, r] of receipts.entries()) {
    const fee = Number(
      (r.commission + r.transfer + ("tax" in r ? r.tax : 0)).toFixed(2),
    );
    old.fill(
      symbol,
      r.date,
      r.side,
      r.quantity,
      r.price,
      fee,
      1,
      r.settledCashChange,
    );
    const f = postPortfolioFill(
      ledger,
      { ...r, symbol, orderId: String(i) },
      1,
    );
    expect([f.quantity, f.price, f.cashDelta]).toEqual([
      BigInt(r.quantity),
      atomsFrom("cn-equity", r.price, "price"),
      atomsFrom("cn-equity", r.settledCashChange, "money"),
    ]);
    const p = ledger.snapshot().positions[0];
    expect(p?.lots.map((l) => l.quantity) ?? []).toEqual(
      (old.positions.get(symbol)?.lots ?? []).map((l) => BigInt(l.quantity)),
    );
    expect(ledger.cash).toBe(atomsFrom("cn-equity", old.cash, "money"));
    expect(ledger.cash + (p ? (p.quantity * p.mark) / 1000000n : 0n)).toBe(
      atomsFrom("cn-equity", old.equity, "money"),
    );
    if (i === 0) {
      const previous = ledger.snapshot();
      expect(() =>
        postPortfolioFill(
          ledger,
          {
            ...r,
            symbol,
            orderId: "locked",
            side: "sell",
            settledCashChange: undefined,
          },
          1,
        ),
      ).toThrow(/T\+1/);
      expect(() =>
        postPortfolioFill(
          ledger,
          { ...r, symbol, orderId: "wrong", settledCashChange: -2005 },
          1,
        ),
      ).toThrow(/reconcile/);
      expect(ledger.snapshot()).toEqual(previous);
      expect(ledger.events()).toHaveLength(1);
    }
  }
});

it.each(["2024-01-03T01:00:00+14:00", "2024-01-02T19:00:00+08:00"])(
  "both accounts lock a Shanghai Jan 2 purchase at %s until Shanghai midnight",
  (locked) => {
    const old = new PortfolioAccount(100);
    const ledger = new ExecutionLedger("cn-equity", 10000n, rates);
    const symbol = "sh600000";
    const replay = (side: "buy" | "sell", date: string) =>
      postPortfolioFill(
        ledger,
        {
          symbol,
          orderId: side,
          date,
          side,
          quantity: 1,
          price: 10,
          commission: 0,
        },
        1,
      );
    const buy = "2024-01-02T10:00:00+08:00";
    old.fill(symbol, buy, "buy", 1, 10, 0, 1);
    replay("buy", buy);
    const before = ledger.snapshot();
    expect(() => old.fill(symbol, locked, "sell", 1, 10, 0, 1)).toThrow(/T\+1/);
    expect(() => replay("sell", locked)).toThrow(/T\+1/);
    expect(ledger.snapshot()).toEqual(before);
    const unlocked = "2024-01-02T16:00:00Z";
    old.fill(symbol, unlocked, "sell", 1, 10, 0, 1);
    replay("sell", unlocked);
    expect(ledger.cash).toBe(atomsFrom("cn-equity", old.cash, "money"));
    expect(ledger.snapshot().positions).toEqual([]);
  },
);
