import { ExecutionLedger, formatDecimal, parseDecimal } from "quant-execution";
import { expect, it } from "vitest";
import { AtomsPortfolioAccount } from "../src/portfolio/atoms-account.js";

const key = "breakout:sh600000";
const day1 = "2026-01-05";
const day2 = "2026-01-06";
const day3 = "2026-01-07";
const cashAtoms = (value: string) => parseDecimal(value, 24);

it("projects the ledger's FIFO lots and rejects a sale of the locked lot without changes", () => {
  const account = new AtomsPortfolioAccount(1_000);
  const ledger = account["ledger"];
  expect(ledger).toBeInstanceOf(ExecutionLedger);

  account.fill(key, day1, "buy", 10, 12, 1, 1);
  account.fill(key, day2, "buy", 5, 13, 0.5, 1);
  expect(account.sellable(key, day2, 1)).toBe(10);
  const before = ledger.snapshot();
  expect(() => account.fill(key, day2, "sell", 11, 15, 0.25, 1)).toThrow(
    /T\+1/,
  );
  expect(() => account.fill(key, day2, "buy", 1_000, 15, 0.25, 1)).toThrow(
    /Insufficient cash/,
  );
  expect(ledger.snapshot()).toEqual(before);

  account.fill(key, day2, "sell", 10, 15, 0.25, 1);
  expect(account.cash).toBe(963.25);
  expect(ledger.cash).toBe(cashAtoms("963.25"));
  expect(ledger.position(key)).toMatchObject({
    quantity: 5_000_000_000_000_000_000n,
    lots: [
      {
        quantity: 5_000_000_000_000_000_000n,
        acquiredAt: day2,
        sellableAt: day3,
      },
    ],
  });
  expect(account.positions.get(key)).toEqual({
    quantity: 5,
    cost: 186.5 / 15,
    mark: 15,
    bought: day2,
    lots: [{ quantity: 5, bought: day2 }],
  });
  expect(account.sellable(key, day2, 1)).toBe(0);
  expect(account.sellable(key, day3, 1)).toBe(5);
});

it("allocates whole-share remainders across split and bonus lots, credits net dividends and settles terminal cash", () => {
  const account = new AtomsPortfolioAccount(1_000);
  const ledger = account["ledger"];
  account.fill(key, day1, "buy", 5, 10, 1, 1);
  account.fill(key, day2, "buy", 4, 15, 1, 1);
  account.positions.get(key)!.mark = 20;
  const sellableAt = `${day2}T02:00:00Z`;
  const action = {
    date: day2,
    availableAt: day2,
    cashAvailableAt: day2,
    timingAssumption: "ex-date-research-scenario",
    sharesSellableAt: sellableAt,
    dividend: 0.4,
    bonus: 0.4,
    shareFactor: 0.5,
    rightsRatio: 0.1,
    rightsPrice: 10,
    evidence: "fixture",
  } as const;
  expect(() =>
    account.corporateAction(
      key,
      { ...action, cashAvailableAt: day3 },
      true,
      2_500,
    ),
  ).toThrow(/cash timing/);
  expect(ledger.cash).toBe(cashAtoms("888"));

  const result = account.corporateAction(key, action, true, 2_500)!;
  expect(result).toMatchObject({
    before: 9,
    quantity: 6,
    cash: 2.7,
    rightsParticipation: "none",
    cashAvailableAt: day2,
    timingAssumption: "ex-date-research-scenario",
  });
  expect(result.fractionalShares).toBeCloseTo(0.3, 14);
  expect(result.costAfter).toBeCloseTo(109.3 / 6, 14);
  expect(result.markAfter).toBeCloseTo(20.6 / 0.75, 13);
  expect(ledger.cash).toBe(cashAtoms("890.7"));
  expect(ledger.position(key)).toMatchObject({
    quantity: 6_000_000_000_000_000_000n,
    lots: [
      {
        quantity: 2_000_000_000_000_000_000n,
        acquiredAt: day1,
        sellableAt: day2,
      },
      {
        quantity: 2_000_000_000_000_000_000n,
        acquiredAt: day2,
        sellableAt: day3,
      },
      { quantity: 2_000_000_000_000_000_000n, acquiredAt: day2, sellableAt },
    ],
  });
  expect(account.positions.get(key)?.lots).toEqual([
    { quantity: 2, bought: day1 },
    { quantity: 2, bought: day2 },
    { quantity: 2, bought: day2, availableOn: sellableAt },
  ]);
  expect(account.sellable(key, `${day2}T09:59:59+08:00`, 1)).toBe(2);
  expect(account.sellable(key, `${day2}T10:00:00+08:00`, 1)).toBe(4);
  account.transfer(-1.2);
  expect(account.terminalValue(key, 4.25)).toBe(25.5);
  // 1000 - 51 - 61 + 2.70 - 1.20 + 25.50
  expect(ledger.snapshot()).toEqual({ cash: cashAtoms("915"), positions: [] });
  expect(account.cash).toBe(915);
  expect(account.equity).toBe(915);
  expect(account.positions.size).toBe(0);
});

it("preserves the research cash checkpoint when a rounded quote differs from the source quote", () => {
  const account = new AtomsPortfolioAccount(10_000);
  const ledger = account["ledger"];
  account.fill(
    "crypto:BTCUSDT",
    day1,
    "buy",
    1_000,
    1.000000004,
    0.000000004,
    0,
  );
  expect(account.sellable("crypto:BTCUSDT", day1, 0)).toBe(1_000);
  expect(ledger.events()).toEqual([
    {
      type: "external-fill",
      fill: {
        orderId: "1",
        symbol: "crypto:BTCUSDT",
        date: day1,
        side: "buy",
        quantity: 1_000_000_000_000_000_000_000n,
        price: 1_000_000_004_000_000_000n,
        commission: cashAtoms("0.000000004"),
        transfer: 0n,
        tax: 0n,
        gross: cashAtoms("1000.000004"),
        cashDelta: cashAtoms("-1000.000004004"),
      },
    },
  ]);
  expect(account.cash).toBe(8_999.999995996);
  expect(account.terminalValue("crypto:BTCUSDT", 0)).toBe(0);
  expect(ledger.snapshot()).toEqual({
    cash: cashAtoms("8999.999995996"),
    positions: [],
  });
});

it("keeps sub-cent cash exact and accepts quantities below the market tick", () => {
  const account = new AtomsPortfolioAccount(1_000_000_000);
  const ledger = account["ledger"];
  account.fill("crypto:BTCUSDT", day1, "buy", 0.00000001, 1, 0, 0);
  expect(account.cash).toBe(999_999_999.99999999);
  expect(formatDecimal(ledger.cash, ledger.cashDecimals)).toBe(
    "999999999.99999999",
  );
  account.fill("crypto:BTCUSDT", day1, "buy", 0.000000001, 1, 0, 0);
  expect(account.positions.get("crypto:BTCUSDT")?.quantity).toBe(0.000000011);
  expect(ledger.position("crypto:BTCUSDT")?.quantity).toBe(
    parseDecimal("0.000000011", 18),
  );
});

it("caps rebalance cash transfers to exact ledger atoms when float64 cash rounds up", () => {
  const account = new AtomsPortfolioAccount(1_000_000_000);
  const ledger = account["ledger"];
  // Subtract 1 atom so float64 `account.cash` rounds back up to 1_000_000_000.
  ledger.transferCash(-1n);
  expect(account.cash).toBe(1_000_000_000);
  expect(() => account.transfer(-account.cash)).toThrow(
    /Invalid cash transfer/,
  );
  const moved = account.transferOutUpToCash(account.cash);
  expect(moved.atoms).toBe(cashAtoms("999999999.9999"));
  expect(ledger.cash).toBe(cashAtoms("0.0001") - 1n);
  // Independent ledger replay using the float64 transfer record must also succeed.
  const replay = new AtomsPortfolioAccount(1_000_000_000);
  replay["ledger"].transferCash(-1n);
  replay.transfer(-moved.amount);
  expect(replay["ledger"].cash).toBe(ledger.cash);
});
