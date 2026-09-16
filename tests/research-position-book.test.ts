import { expect, it } from "vitest";
import {
  researchPositionBook,
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
} from "../src/lib/research-position-book";

const first = () =>
  researchBookBuy(researchPositionBook(), {
    date: "2024-01-02",
    quantity: 500,
    price: 100,
    commission: 5,
  });

it("allocates actual fees by FIFO across 50/30/20 buys and partial exits", () => {
  let book = first();
  book = researchBookBuy(book, {
    date: "2024-01-03",
    quantity: 300,
    price: 105,
    commission: 5,
  });
  book = researchBookBuy(book, {
    date: "2024-01-04",
    quantity: 200,
    price: 110,
    commission: 5,
  });
  expect(book.totalCost).toBe(103515);
  const sale = researchBookSell(book, {
    date: "2024-01-05",
    quantity: 600,
    price: 120,
    commission: 5,
    tax: 72,
  });
  expect(sale.netProceeds).toBe(71923);
  expect(sale.releasedCost).toBeCloseTo(60506.6666666667);
  expect(sale.book.remainingCost).toBeCloseTo(43008.3333333333);
  expect(sale.book.realizedProfit).toBeCloseTo(11416.3333333333);
  expect(sale.book.lots.map((lot) => lot.remainingQuantity)).toEqual([
    0, 200, 200,
  ]);
  const closed = researchBookSell(sale.book, {
    date: "2024-01-08",
    quantity: 400,
    price: 90,
    commission: 5,
    tax: 36,
  }).book;
  expect(closed.remainingQuantity).toBe(0);
  expect(closed.remainingCost).toBe(0);
  expect(closed.realizedProfit).toBe(4367);
  expect(closed.totalQuantity).toBe(1000);
  expect(book.remainingQuantity).toBe(1000);
});

it("allows older shares to sell on an add day without selling the new lot", () => {
  const book = researchBookBuy(first(), {
    date: "2024-01-03",
    quantity: 300,
    price: 105,
    commission: 5,
  });
  expect(researchBookSellable(book, "2024-01-03")).toBe(500);
  expect(() =>
    researchBookSell(book, {
      date: "2024-01-03",
      quantity: 501,
      price: 110,
      commission: 5,
      tax: 0,
    }),
  ).toThrow("可卖");
  const sold = researchBookSell(book, {
    date: "2024-01-03",
    quantity: 500,
    price: 110,
    commission: 5,
    tax: 0,
  }).book;
  expect(researchBookSellable(sold, "2024-01-03")).toBe(0);
  expect(researchBookSellable(sold, "2024-01-04")).toBe(300);
  expect(sold.remainingCost).toBe(31505);
});

it("retains negative net proceeds for fees larger than a tiny sale", () => {
  const book = researchBookBuy(researchPositionBook(), {
    date: "2024-01-02",
    quantity: 1,
    price: 1,
    commission: 5,
  });
  const sale = researchBookSell(book, {
    date: "2024-01-03",
    quantity: 1,
    price: 1,
    commission: 5,
    tax: 0,
  });
  expect(sale.netProceeds).toBe(-4);
  expect(sale.book.realizedProfit).toBe(-10);
});

it("rejects invalid fills, invalid calendar dates and out-of-order mutations", () => {
  const book = first();
  for (const quantity of [0, -1, 1.5, NaN, Infinity]) {
    expect(() =>
      researchBookBuy(book, {
        date: "2024-01-03",
        quantity,
        price: 100,
        commission: 5,
      }),
    ).toThrow();
  }
  for (const date of ["2024-01-01", "2024-02-30", "garbage"]) {
    expect(() =>
      researchBookBuy(book, { date, quantity: 100, price: 100, commission: 5 }),
    ).toThrow();
  }
  expect(() =>
    researchBookBuy(book, {
      date: "2024-01-03",
      quantity: 100,
      price: 100,
      commission: -1,
    }),
  ).toThrow();
  expect(() =>
    researchBookSell(book, {
      date: "2024-01-03",
      quantity: 501,
      price: 100,
      commission: 5,
      tax: 0,
    }),
  ).toThrow();
  expect(book.remainingQuantity).toBe(500);
});
