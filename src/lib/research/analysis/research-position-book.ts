import { big, moneyMul, toNumber } from "../../money";

/** Research-only FIFO cost allocation. Prices are actual simulated fills;
 * commission is supplied once per order by the execution layer. */
export type ResearchPositionLot = {
  date: string;
  quantity: number;
  price: number;
  cost: number;
  remainingQuantity: number;
  remainingCost: number;
};

export type ResearchPositionBook = {
  lots: ResearchPositionLot[];
  totalQuantity: number;
  totalCost: number;
  remainingQuantity: number;
  remainingCost: number;
  realizedProceeds: number;
  realizedProfit: number;
  lastDate: string | null;
};

export function researchPositionBook(): ResearchPositionBook {
  return {
    lots: [],
    totalQuantity: 0,
    totalCost: 0,
    remainingQuantity: 0,
    remainingCost: 0,
    realizedProceeds: 0,
    realizedProfit: 0,
    lastDate: null,
  };
}

function checkDate(book: ResearchPositionBook, date: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    (book.lastDate !== null && date < book.lastDate)
  )
    throw new Error("批次日期无效或早于已有交易");
}

function checkFill(quantity: number, price: number, ...fees: number[]) {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    !Number.isFinite(price) ||
    price <= 0 ||
    fees.some((fee) => !Number.isFinite(fee) || fee < 0) ||
    !Number.isFinite(quantity * price + fees.reduce((a, b) => a + b, 0))
  )
    throw new Error("批次成交数量、价格或费用无效");
}

export function researchBookBuy(
  book: ResearchPositionBook,
  fill: { date: string; quantity: number; price: number; commission: number },
): ResearchPositionBook {
  checkDate(book, fill.date);
  checkFill(fill.quantity, fill.price, fill.commission);
  const cost = toNumber(
    big(moneyMul(fill.quantity, fill.price)).plus(fill.commission),
  );
  const totalQuantity = book.totalQuantity + fill.quantity;
  const totalCost = toNumber(big(book.totalCost).plus(cost));
  if (!Number.isSafeInteger(totalQuantity) || !Number.isFinite(totalCost))
    throw new Error("批次累计数量或成本溢出");
  return {
    ...book,
    lots: [
      ...book.lots,
      {
        date: fill.date,
        quantity: fill.quantity,
        price: fill.price,
        cost,
        remainingQuantity: fill.quantity,
        remainingCost: cost,
      },
    ],
    totalQuantity,
    totalCost,
    remainingQuantity: book.remainingQuantity + fill.quantity,
    remainingCost: toNumber(big(book.remainingCost).plus(cost)),
    lastDate: fill.date,
  };
}

/** T+1 is evaluated per acquisition lot, not only at first entry. */
export function researchBookSellable(book: ResearchPositionBook, date: string) {
  checkDate(book, date);
  return book.lots.reduce(
    (quantity, lot) => quantity + (lot.date < date ? lot.remainingQuantity : 0),
    0,
  );
}

export function researchBookSell(
  book: ResearchPositionBook,
  fill: {
    date: string;
    quantity: number;
    price: number;
    commission: number;
    tax: number;
  },
): { book: ResearchPositionBook; releasedCost: number; netProceeds: number } {
  checkDate(book, fill.date);
  checkFill(fill.quantity, fill.price, fill.commission, fill.tax);
  if (fill.quantity > researchBookSellable(book, fill.date))
    throw new Error("卖出数量超过当日可卖批次");
  let needed = fill.quantity;
  let releasedCost = 0;
  const lots = book.lots.map((lot) => {
    if (!needed || lot.date >= fill.date || !lot.remainingQuantity) return lot;
    const quantity = Math.min(needed, lot.remainingQuantity);
    const cost =
      quantity === lot.remainingQuantity
        ? lot.remainingCost
        : toNumber(
            big(lot.remainingCost).times(quantity).div(lot.remainingQuantity),
          );
    needed -= quantity;
    releasedCost = toNumber(big(releasedCost).plus(cost));
    return {
      ...lot,
      remainingQuantity: lot.remainingQuantity - quantity,
      remainingCost:
        quantity === lot.remainingQuantity
          ? 0
          : toNumber(big(lot.remainingCost).minus(cost)),
    };
  });
  const netProceeds = toNumber(
    big(moneyMul(fill.quantity, fill.price))
      .minus(fill.commission)
      .minus(fill.tax),
  );
  const remainingQuantity = book.remainingQuantity - fill.quantity;
  const realizedProceeds = toNumber(big(book.realizedProceeds).plus(netProceeds));
  const remainingCost =
    remainingQuantity === 0
      ? 0
      : toNumber(
          lots.reduce((sum, lot) => sum.plus(lot.remainingCost), big(0)),
        );
  return {
    releasedCost,
    netProceeds,
    book: {
      ...book,
      lots,
      remainingQuantity,
      remainingCost,
      realizedProceeds,
      realizedProfit: toNumber(
        big(realizedProceeds).minus(big(book.totalCost).minus(remainingCost)),
      ),
      lastDate: fill.date,
    },
  };
}
