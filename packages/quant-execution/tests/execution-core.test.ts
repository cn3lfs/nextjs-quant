import { expect, it } from "vitest";
import {
  atomsFrom,
  atomsText,
  ExecutionLedger,
  type CorporateActionEffect,
  type CostRates,
  type ExecutionQuote,
  type OrderIntent,
} from "../src/index.js";

const market = "cn-equity" as const;
const money = (value: string | number) => atomsFrom(market, value, "money");
const price = (value: string | number) => atomsFrom(market, value, "price");
const quantity = (value: string | number) =>
  atomsFrom(market, value, "quantity");
const rates: CostRates = {
  commissionBps: 3,
  minimumCommission: money(5),
  transferBps: 0.1,
  sellTaxBps: 5,
  slippageBps: 5,
};
const quote = (date: string, open = 10): ExecutionQuote => ({
  date,
  open: price(open),
  high: price(10.2),
  low: price(9.8),
  close: price(open),
  volume: quantity(1_000_000),
  tradable: true,
});
const order = (patch: Partial<OrderIntent> = {}): OrderIntent => ({
  id: "o1",
  symbol: "sh600000",
  side: "buy",
  quantity: quantity(100),
  ...patch,
});

it("matches next open with adverse slippage and itemized A-share costs", () => {
  const ledger = new ExecutionLedger(market, money(10_000), rates);
  ledger.submit(order());
  ledger.matchOpen("2026-01-05", new Map([["sh600000", quote("2026-01-05")]]));
  const fill = ledger.events().find((event) => event.type === "filled");
  if (fill?.type !== "filled") throw new Error("missing fill");
  expect(atomsText(market, fill.fill.price, "price")).toBe("10.005");
  expect(atomsText(market, fill.fill.gross, "money")).toBe("1000.5");
  expect(atomsText(market, fill.fill.commission, "money")).toBe("5");
  expect(atomsText(market, fill.fill.transfer, "money")).toBe("0.01");
  expect(atomsText(market, fill.fill.tax, "money")).toBe("0");
  expect(atomsText(market, ledger.cash, "money")).toBe("8994.49");
  expect(
    atomsText(market, ledger.snapshot().positions[0]!.quantity, "quantity"),
  ).toBe("100");
});

it("enforces T+1, then charges sell tax and transfer on the next session", () => {
  const ledger = new ExecutionLedger(market, money(10_000), rates);
  ledger.submit(order());
  ledger.matchOpen("2026-01-05", new Map([["sh600000", quote("2026-01-05")]]));
  ledger.submit(order({ id: "o2", side: "sell" }));
  ledger.matchOpen("2026-01-05", new Map([["sh600000", quote("2026-01-05")]]));
  expect(ledger.events().some((event) => event.type === "rejected")).toBe(true);
  ledger.matchOpen("2026-01-06", new Map([["sh600000", quote("2026-01-06")]]));
  const fill = ledger
    .events()
    .filter((event) => event.type === "filled")
    .at(-1);
  if (fill?.type !== "filled") throw new Error("missing sell");
  expect(atomsText(market, fill.fill.price, "price")).toBe("9.995");
  expect(atomsText(market, fill.fill.tax, "money")).toBe("0.5");
  expect(atomsText(market, fill.fill.transfer, "money")).toBe("0.01");
  expect(ledger.snapshot().positions).toEqual([]);
});

it("applies splits and cash dividends without breaking lot or cost invariants", () => {
  const ledger = new ExecutionLedger(market, money(10_000), rates);
  ledger.submit(order());
  ledger.matchOpen("2026-01-05", new Map([["sh600000", quote("2026-01-05")]]));
  const effect: CorporateActionEffect = {
    date: "2026-01-06",
    symbol: "sh600000",
    cashPerShare: money(1),
    shareFactor: 2,
    shareDelta: 0n,
    evidence: "fixture split + dividend",
  };
  const beforeCash = ledger.cash;
  ledger.applyCorporateAction(effect);
  const position = ledger.snapshot().positions[0]!;
  expect(atomsText(market, position.quantity, "quantity")).toBe("200");
  expect(atomsText(market, position.mark, "price")).toBe("5.0025");
  expect(position.lots.reduce((total, lot) => total + lot.quantity, 0n)).toBe(
    position.quantity,
  );
  expect(ledger.cash).toBe(beforeCash + money(100));
});

it("rejects locked limits and one-price bars instead of inventing fills", () => {
  const ledger = new ExecutionLedger(market, money(10_000), rates);
  ledger.submit(order());
  ledger.matchOpen(
    "2026-01-05",
    new Map([
      [
        "sh600000",
        {
          ...quote("2026-01-05"),
          limitUp: price(11),
          open: price(11),
        },
      ],
    ]),
  );
  expect(ledger.events().some((event) => event.type === "rejected")).toBe(true);
  const onePrice = new ExecutionLedger(market, money(10_000), rates);
  onePrice.submit(order());
  onePrice.matchOpen(
    "2026-01-05",
    new Map([
      [
        "sh600000",
        {
          ...quote("2026-01-05"),
          high: price(10),
          low: price(10),
        },
      ],
    ]),
  );
  expect(onePrice.events().some((event) => event.type === "rejected")).toBe(
    true,
  );
});

it("credits bonus shares to their own lot and sells them at the explicit unlock instant", () => {
  const ledger = new ExecutionLedger(market, money(10_000), rates);
  const symbol = "sh600000";
  ledger.submit(order());
  ledger.matchOpen("2026-01-05", new Map([[symbol, quote("2026-01-05")]]));
  const action = {
    symbol,
    date: "2026-01-06",
    cashPerShare: 0n,
    shareFactor: 1,
    shareDelta: 25n,
    evidence: "bonus shares",
  };
  const before = ledger.snapshot();
  expect(() => ledger.applyCorporateAction(action)).toThrow(/sharesSellableAt/);
  expect(ledger.snapshot()).toEqual(before);
  ledger.applyCorporateAction({
    ...action,
    sharesSellableAt: "2026-01-07T10:00:00+08:00",
  });
  const position = ledger.snapshot().positions[0]!;
  expect(position.quantity).toBe(125n);
  expect(position.lots.map((lot) => lot.quantity)).toEqual([100n, 25n]);
  expect(ledger.sellable(symbol, "2026-01-07T01:59:59Z")).toBe(100n);
  const unlocked = "2026-01-07T02:00:00Z";
  expect(ledger.sellable(symbol, unlocked)).toBe(125n);
  ledger.submit(order({ id: "sell-all", side: "sell", quantity: 125n }));
  ledger.matchOpen(unlocked, new Map([[symbol, quote(unlocked)]]));
  expect(ledger.snapshot().positions).toEqual([]);
});

it("keeps aggregate split rounding and a negative share adjustment reconciled across lots", () => {
  const ledger = new ExecutionLedger(market, money(1000), rates);
  const symbol = "sh600000";
  for (const date of ["2026-01-05", "2026-01-06"]) {
    ledger.submit(order({ id: date, quantity: 3n }));
    ledger.matchOpen(date, new Map([[symbol, quote(date)]]));
  }
  const effect = {
    symbol,
    date: "2026-01-07",
    cashPerShare: 0n,
    shareFactor: 0.5,
    shareDelta: 0n,
    evidence: "fixture",
  };
  ledger.applyCorporateAction(effect);
  expect(
    ledger.snapshot().positions[0]!.lots.map((lot) => lot.quantity),
  ).toEqual([2n, 1n]);
  ledger.applyCorporateAction({ ...effect, shareFactor: 1, shareDelta: -1n });
  expect(ledger.snapshot().positions[0]!.quantity).toBe(2n);
  expect(ledger.sellable(symbol, effect.date)).toBe(2n);
});

it("allocates consolidation remainders by largest remainder, matching the research ledger", () => {
  const ledger = new ExecutionLedger(market, money(10_000), rates);
  for (const [id, day] of [
    ["a", "2026-01-05"],
    ["b", "2026-01-06"],
  ] as const) {
    ledger.submit({
      id,
      symbol: "sh600000",
      side: "buy",
      quantity: quantity(101),
    });
    ledger.matchOpen(day, new Map([["sh600000", quote(day)]]));
  }
  ledger.applyCorporateAction({
    date: "2026-01-07",
    symbol: "sh600000",
    cashPerShare: 0n,
    shareFactor: 0.5,
    shareDelta: 0n,
    evidence: "fixture consolidation",
  });
  const position = ledger.snapshot().positions[0]!;
  expect(atomsText(market, position.quantity, "quantity")).toBe("101");
  expect(position.lots.map((lot) => Number(lot.quantity))).toEqual([51, 50]);
});
