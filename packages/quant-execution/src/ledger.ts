import {
  atomScales,
  bpsOf,
  formatDecimal,
  mulQuantity,
  notional,
  parseDecimal,
  scaleAtoms,
  type Atoms,
  type Market,
} from "./atoms.js";
import { feesFor } from "./costs.js";
import { matchOpen } from "./matching.js";
import type {
  AccountState,
  CorporateActionEffect,
  CostRates,
  ExecutionEvent,
  ExecutionQuote,
  Fill,
  OrderIntent,
  PositionLot,
  PositionState,
} from "./types.js";

type Lot = {
  quantity: Atoms;
  price: Atoms;
  acquiredAt: string;
  sellableAt: string;
};
type Position = {
  quantity: Atoms;
  cost: Atoms;
  mark: Atoms;
  lots: Lot[];
};

const dayAfter = (date: string, market: Market) => {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error("成交日期非法");
  if (market === "crypto") return date.slice(0, 10);
  do parsed.setUTCDate(parsed.getUTCDate() + 1);
  while ([0, 6].includes(parsed.getUTCDay()));
  return parsed.toISOString().slice(0, 10);
};

export class ExecutionLedger {
  readonly market: Market;
  readonly rates: CostRates;
  private cashAtoms: Atoms;
  private readonly positions = new Map<string, Position>();
  private readonly pending = new Map<string, OrderIntent>();
  private readonly log: ExecutionEvent[] = [];

  constructor(market: Market, initialCash: Atoms, rates: CostRates) {
    if (initialCash <= 0n) throw new Error("初始资金必须为正");
    this.market = market;
    this.cashAtoms = initialCash;
    this.rates = rates;
  }

  get cash() {
    return this.cashAtoms;
  }

  submit(order: OrderIntent) {
    if (order.quantity <= 0n) throw new Error("订单数量必须为正");
    if (this.pending.has(order.id)) throw new Error(`重复订单：${order.id}`);
    this.pending.set(order.id, { ...order });
    this.log.push({ type: "submitted", order: { ...order } });
  }

  sellable(symbol: string, date: string) {
    const position = this.positions.get(symbol);
    if (!position) return 0n;
    const day = date.slice(0, 10);
    return position.lots
      .filter((lot) => lot.sellableAt <= day)
      .reduce((total, lot) => total + lot.quantity, 0n);
  }

  /** Match all due pending orders at the supplied session opens. */
  matchOpen(date: string, quotes: ReadonlyMap<string, ExecutionQuote>) {
    const orders = [...this.pending.values()]
      .filter((order) => !order.due || order.due <= date)
      .sort(
        (a, b) =>
          Number(a.side === "sell") * -1 - Number(b.side === "sell") * -1 ||
          a.id.localeCompare(b.id),
      );
    for (const order of orders) {
      const quote = quotes.get(order.symbol);
      if (!quote) {
        this.reject(order, date, "缺 bar 或停牌", order.side === "sell");
        continue;
      }
      const side = order.side;
      const available =
        side === "sell" ? this.sellable(order.symbol, date) : order.quantity;
      const quantity =
        side === "sell" && available < order.quantity
          ? available
          : order.quantity;
      if (quantity <= 0n) {
        this.reject(order, date, "T+1：当日买入不可卖出", true);
        continue;
      }
      const matched = matchOpen(order, quote, this.rates);
      if (!matched.ok) {
        this.reject(order, date, matched.reason, side === "sell");
        continue;
      }
      const gross = notional(quantity, matched.price, this.market);
      const fees = feesFor(side, gross, this.rates);
      const cashDelta =
        side === "buy" ? -(gross + fees.total) : gross - fees.total;
      if (this.cashAtoms + cashDelta < 0n) {
        this.reject(order, date, "资金不足", false);
        continue;
      }
      const fill: Fill = {
        orderId: order.id,
        symbol: order.symbol,
        side,
        date,
        quantity,
        price: matched.price,
        gross,
        commission: fees.commission,
        transfer: fees.transfer,
        tax: fees.tax,
        cashDelta,
      };
      this.applyFill(fill);
      this.log.push({ type: "filled", fill });
      this.pending.delete(order.id);
    }
  }

  applyExternalFill(
    fill: Omit<Fill, "gross" | "commission" | "transfer" | "tax"> & {
      gross?: Atoms;
      commission?: Atoms;
      transfer?: Atoms;
      tax?: Atoms;
    },
  ) {
    const gross =
      fill.gross ?? notional(fill.quantity, fill.price, this.market);
    const complete: Fill = {
      ...fill,
      gross,
      commission: fill.commission ?? 0n,
      transfer: fill.transfer ?? 0n,
      tax: fill.tax ?? 0n,
    };
    this.applyFill(complete);
    this.log.push({ type: "external-fill", fill: complete });
  }

  applyCorporateAction(effect: CorporateActionEffect) {
    const position = this.positions.get(effect.symbol);
    if (!position) return;
    const grossCash = mulQuantity(
      position.quantity,
      effect.cashPerShare,
      this.market,
    );
    const cash = grossCash - bpsOf(grossCash, this.rates.dividendTaxBps ?? 0);
    this.cashAtoms += cash;
    const factor = effect.shareFactor;
    const scaled = Math.floor(Number(position.quantity) * factor);
    const next = BigInt(scaled) + effect.shareDelta;
    const cost =
      next > 0n ? (position.cost > cash ? position.cost - cash : 0n) : 0n;
    position.quantity = next;
    position.cost = cost;
    position.mark = scaleAtoms(position.mark, 1 / factor, "half-up");
    if (factor === 1 && effect.shareDelta === 0n) {
      // Dividend-only actions keep lots unchanged.
    } else {
      position.lots = position.lots.map((lot) => ({
        ...lot,
        quantity: BigInt(Math.floor(Number(lot.quantity) * factor)),
      }));
    }
    if (position.quantity <= 0n) this.positions.delete(effect.symbol);
    else this.positions.set(effect.symbol, position);
    this.log.push({ type: "corporate-action", effect, cash });
  }

  snapshot(): AccountState {
    return {
      cash: this.cashAtoms,
      positions: [...this.positions].map(([symbol, position]) => ({
        symbol,
        quantity: position.quantity,
        cost: position.cost,
        mark: position.mark,
        lots: position.lots.map((lot) => ({ ...lot })),
      })),
    };
  }

  events() {
    return this.log.map((event) => structuredClone(event));
  }

  private applyFill(fill: Fill) {
    this.cashAtoms += fill.cashDelta;
    const position = this.positions.get(fill.symbol) ?? {
      quantity: 0n,
      cost: 0n,
      mark: fill.price,
      lots: [],
    };
    if (fill.side === "buy") {
      position.quantity += fill.quantity;
      position.cost += fill.gross + fill.commission + fill.transfer + fill.tax;
      position.lots.push({
        quantity: fill.quantity,
        price: fill.price,
        acquiredAt: fill.date,
        sellableAt: dayAfter(fill.date, this.market),
      });
    } else {
      let remaining = fill.quantity;
      for (const lot of position.lots) {
        if (lot.sellableAt > fill.date.slice(0, 10)) continue;
        const sold = lot.quantity < remaining ? lot.quantity : remaining;
        lot.quantity -= sold;
        remaining -= sold;
        if (remaining === 0n) break;
      }
      position.lots = position.lots.filter((lot) => lot.quantity > 0n);
      const before = position.quantity;
      position.quantity -= fill.quantity;
      position.cost =
        before > 0n ? (position.cost * (before - fill.quantity)) / before : 0n;
    }
    position.mark = fill.price;
    if (position.quantity <= 0n) this.positions.delete(fill.symbol);
    else this.positions.set(fill.symbol, position);
  }

  private reject(
    order: OrderIntent,
    date: string,
    reason: string,
    keep: boolean,
  ) {
    this.log.push({
      type: "rejected",
      rejection: { orderId: order.id, symbol: order.symbol, date, reason },
    });
    if (!keep) this.pending.delete(order.id);
  }
}

export function atomsFrom(
  market: Market,
  value: string | number,
  kind: "money" | "quantity" | "price",
) {
  return parseDecimal(value, atomScales[market][kind]);
}

export function atomsText(
  market: Market,
  value: Atoms,
  kind: "money" | "quantity" | "price",
) {
  return formatDecimal(value, atomScales[market][kind]);
}
