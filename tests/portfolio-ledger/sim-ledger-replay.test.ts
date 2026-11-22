import { expect, it } from "vitest";
import { AccountBook } from "../../packages/quant-execution/src";
import {
  replayPositions,
  type ReplayFill,
} from "~/server/portfolio/sim-accounts/engine";

it("不同价格的批次共用移动成本，半分进位后仅扣已结算的股份", () => {
  const symbol = "sh600519";
  const day = "2026-11-20";
  const base = {
    symbol,
    side: "buy" as const,
    quantity_atoms: 100n,
    commission_atoms: 0n,
    tax_atoms: 0n,
    slippage_atoms: 0n,
  };
  const fills: ReplayFill[] = [
    {
      ...base,
      trade_date: "2026-11-19",
      gross_atoms: 100000n,
      transfer_atoms: 1n,
    },
    { ...base, trade_date: day, gross_atoms: 200000n },
    { ...base, trade_date: day, side: "sell", gross_atoms: 180000n },
  ];
  type Lot = { quantity: bigint; date: string };
  type Position = { quantity: bigint; mark: bigint; cost: bigint; lots: Lot[] };
  const book = new AccountBook<bigint, Lot, Position>(0n, {
    zero: 0n,
    add: (a, b) => a + b,
    subtract: (a, b) => a - b,
    keepLot: (q) => q > 0n,
    keepPosition: (q) => q > 0n,
  });
  // Independently calculated total basis after each fill, in fen.
  const basis = [100001n, 300001n, 150000n];
  for (const [index, fill] of fills.entries()) {
    book.postFill(
      symbol,
      fill.side,
      fill.quantity_atoms,
      0n,
      0n,
      (lot) => lot.date < fill.trade_date,
      () => ({ quantity: fill.quantity_atoms, date: fill.trade_date }),
      (_, quantity, lots) => ({
        quantity,
        mark: 0n,
        lots,
        cost: basis[index]!,
      }),
      () => basis[index]!,
    );
    const position = book.positions.get(symbol)!;
    expect(
      replayPositions(fills.slice(0, index + 1), "cn-equity", day).get(symbol),
    ).toEqual({
      quantity: position.quantity,
      basis: position.cost,
      sellable: position.lots
        .filter((lot) => lot.date < day)
        .reduce((total, lot) => total + lot.quantity, 0n),
    });
  }
  expect(book.positions.get(symbol)?.lots).toEqual([
    { quantity: 100n, date: day },
  ]);
  expect(() =>
    replayPositions([...fills, fills[2]!], "cn-equity", "2026-11-23"),
  ).toThrow("可卖数量不足");
});
