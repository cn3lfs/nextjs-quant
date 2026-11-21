import { AccountBook } from "./account-book.js";
import {
  lotAvailable,
  replaySellableDate,
  settlementDate,
} from "./settlement.js";
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
  const day = settlementDate(date, market === "cn-equity" ? 1 : 0);
  const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) throw new Error("成交日期非法");
  if (market === "crypto") return day;
  do parsed.setUTCDate(parsed.getUTCDate() + 1);
  while ([0, 6].includes(parsed.getUTCDay()));
  return parsed.toISOString().slice(0, 10);
};

export class ExecutionLedger {
  readonly market: Market;
  readonly rates: CostRates;
  private readonly book: AccountBook<Atoms, Lot, Position>;
  private readonly pending = new Map<string, OrderIntent>();
  private readonly log: ExecutionEvent[] = [];

  constructor(market: Market, initialCash: Atoms, rates: CostRates) {
    if (initialCash <= 0n) throw new Error("初始资金必须为正");
    this.market = market;
    this.book = new AccountBook<Atoms, Lot, Position>(initialCash, {
      zero: 0n,
      add: (a, b) => a + b,
      subtract: (a, b) => a - b,
      keepLot: (q) => q > 0n,
      keepPosition: (q) => q > 0n,
    });
    this.rates = rates;
  }

  get cash() {
    return this.book.cash;
  }

  submit(order: OrderIntent) {
    if (order.quantity <= 0n) throw new Error("订单数量必须为正");
    if (this.pending.has(order.id)) throw new Error(`重复订单：${order.id}`);
    this.pending.set(order.id, { ...order });
    this.log.push({ type: "submitted", order: { ...order } });
  }

  sellable(symbol: string, date: string) {
    const position = this.book.positions.get(symbol);
    if (!position) return 0n;
    return position.lots
      .filter((lot) => this.isAvailable(lot, date))
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
      if (this.book.cash + cashDelta < 0n) {
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

  /** Post a replay receipt whose fee and net settlement are already known. */
  applyReplayFill(fill: Fill, settlementDays: 0 | 1) {
    const available = (lot: Lot) =>
      this.isAvailable(lot, fill.date, settlementDays);
    const gross = notional(fill.quantity, fill.price, this.market);
    const fee = fill.commission + fill.transfer + fill.tax;
    if (
      fill.quantity <= 0n ||
      fill.price <= 0n ||
      [fill.commission, fill.transfer, fill.tax].some((value) => value < 0n) ||
      gross !== fill.gross ||
      (fill.side === "buy" ? -gross : gross) - fee !== fill.cashDelta
    )
      throw new Error("Settlement does not reconcile to fill");
    if (fill.side === "sell") {
      const lots = this.book.positions.get(fill.symbol)?.lots ?? [];
      const sellable = lots.reduce(
        (sum, lot) => (available(lot) ? sum + lot.quantity : sum),
        0n,
      );
      if (sellable < fill.quantity)
        throw new Error("T+1 / insufficient inventory");
    }
    if (this.book.cash + fill.cashDelta < 0n)
      throw new Error("Insufficient cash");
    this.applyFill(
      fill,
      available,
      replaySellableDate(fill.date, settlementDays),
    );
    this.log.push({ type: "external-fill", fill: { ...fill } });
  }
  applyCorporateAction(effect: CorporateActionEffect) {
    const position = this.book.positions.get(effect.symbol);
    if (!position) return;
    const grossCash = mulQuantity(
      position.quantity,
      effect.cashPerShare,
      this.market,
    );
    const cash = grossCash - bpsOf(grossCash, this.rates.dividendTaxBps ?? 0);
    const factor = effect.shareFactor;
    const scaledQuantity = (quantity: Atoms) =>
      factor === 1 ? quantity : BigInt(Math.floor(Number(quantity) * factor));
    const scaledTotal = scaledQuantity(position.quantity);
    if (scaledTotal + effect.shareDelta < 0n)
      throw new Error("Corporate action exceeds inventory");
    const next = scaledTotal + effect.shareDelta;
    const cost =
      next > 0n ? (position.cost > cash ? position.cost - cash : 0n) : 0n;
    // Largest-remainder allocation, matching the decimal research ledger.
    const scaledLots =
      factor === 1
        ? position.lots.map((lot) => ({
            lot,
            quantity: lot.quantity,
            remainder: 0,
          }))
        : position.lots.map((lot) => {
            const exact = Number(lot.quantity) * factor;
            const quantity = BigInt(Math.floor(exact));
            return { lot, quantity, remainder: exact - Math.floor(exact) };
          });
    let residual =
      scaledTotal - scaledLots.reduce((sum, row) => sum + row.quantity, 0n);
    for (const row of [...scaledLots].sort(
      (a, b) =>
        b.remainder - a.remainder ||
        position.lots.indexOf(a.lot) - position.lots.indexOf(b.lot),
    )) {
      if (residual <= 0n) break;
      row.quantity += 1n;
      residual -= 1n;
    }
    const lots = scaledLots
      .map((row) => ({ ...row.lot, quantity: row.quantity }))
      .filter((lot) => lot.quantity > 0n);
    if (effect.shareDelta > 0n) {
      if (
        !effect.sharesSellableAt ||
        !Number.isFinite(Date.parse(effect.sharesSellableAt))
      )
        throw new Error("Positive shareDelta requires sharesSellableAt");
      lots.push({
        quantity: effect.shareDelta,
        price: 0n,
        acquiredAt: effect.date,
        sellableAt: effect.sharesSellableAt,
      });
    } else if (effect.shareDelta < 0n) {
      let remove = -effect.shareDelta;
      for (let i = lots.length - 1; i >= 0 && remove > 0n; i--) {
        const take = lots[i]!.quantity < remove ? lots[i]!.quantity : remove;
        lots[i]!.quantity -= take;
        remove -= take;
      }
    }
    const lotsTotal = lots.reduce((sum, lot) => sum + lot.quantity, 0n);
    if (lotsTotal !== next)
      throw new Error("Corporate action lot total does not reconcile");
    this.book.postAction(effect.symbol, position, this.book.cash + cash, {
      quantity: next,
      cost,
      lots: lots.filter((lot) => lot.quantity > 0n),
      mark: scaleAtoms(position.mark, 1 / factor, "half-up"),
    });
    this.log.push({ type: "corporate-action", effect, cash });
  }

  snapshot(): AccountState {
    return {
      cash: this.book.cash,
      positions: [...this.book.positions].map(([symbol, position]) => ({
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

  private isAvailable(
    lot: Lot,
    date: string,
    settlementDays: 0 | 1 = this.market === "cn-equity" ? 1 : 0,
  ) {
    return lotAvailable(
      { bought: lot.acquiredAt, availableOn: lot.sellableAt },
      date,
      settlementDays,
    );
  }

  private applyFill(
    fill: Fill,
    available = (lot: Lot) => this.isAvailable(lot, fill.date),
    replayAvailability?: string,
  ) {
    this.book.postFill(
      fill.symbol,
      fill.side,
      fill.quantity,
      fill.price,
      this.book.cash + fill.cashDelta,
      available,
      () => ({
        quantity: fill.quantity,
        price: fill.price,
        acquiredAt: fill.date,
        sellableAt: replayAvailability ?? dayAfter(fill.date, this.market),
      }),
      (prior, quantity, lots) => ({
        quantity,
        lots,
        mark: fill.price,
        cost:
          (prior?.cost ?? 0n) +
          fill.gross +
          fill.commission +
          fill.transfer +
          fill.tax,
      }),
      (prior, remaining) =>
        prior.quantity > 0n ? (prior.cost * remaining) / prior.quantity : 0n,
    );
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
