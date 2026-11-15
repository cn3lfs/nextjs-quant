import { big, moneyMul, toNumber } from "trading-strategy-core/money";

export type PortfolioLot = {
  quantity: number;
  bought: string;
  availableOn?: string;
};
export type PortfolioPosition = {
  quantity: number;
  cost: number;
  mark: number;
  lots: PortfolioLot[];
  bought: string;
};
/** One ledger for all replay policies. Signals never write cash or inventory. */
export class PortfolioAccount {
  cash: number;
  readonly positions = new Map<string, PortfolioPosition>();
  constructor(initial: number) {
    if (!Number.isFinite(initial) || initial <= 0)
      throw new Error("Invalid initial cash");
    this.cash = initial;
  }
  get equity() {
    return toNumber(
      [...this.positions.values()].reduce(
        (n, p) => n.plus(big(p.quantity).times(p.mark)),
        big(this.cash),
      ),
    );
  }
  sellable(key: string, day: string, settlementDays: 0 | 1) {
    return (
      this.positions
        .get(key)
        ?.lots.reduce(
          (n, lot) =>
            n +
            (lot.availableOn !== undefined
              ? lot.availableOn <= day
                ? lot.quantity
                : 0
              : settlementDays === 0 || lot.bought < day
                ? lot.quantity
                : 0),
          0,
        ) ?? 0
    );
  }
  transfer(amount: number) {
    const next = toNumber(big(this.cash).plus(amount));
    if (!Number.isFinite(amount) || next < -1e-8)
      throw new Error("Invalid cash transfer");
    this.cash = next;
  }
  /** Sensitivity valuation at terminal source coverage, not a market fill.
   * Zero is the explicitly requested total-loss scenario. No tradability or
   * settlement date is inferred from the final observed price. */
  terminalValue(key: string, price: number) {
    if (!Number.isFinite(price) || price < 0)
      throw new Error("Invalid terminal valuation");
    const position = this.positions.get(key);
    if (!position) return 0;
    const amount = moneyMul(position.quantity, price);
    this.transfer(amount);
    this.positions.delete(key);
    return amount;
  }
  fill(
    key: string,
    day: string,
    side: "buy" | "sell",
    quantity: number,
    price: number,
    fee: number,
    settlementDays: 0 | 1,
    settledCashChange?: number,
  ) {
    const p = this.positions.get(key);
    if (
      ![quantity, price].every((v) => Number.isFinite(v) && v > 0) ||
      !Number.isFinite(fee) ||
      fee < 0
    )
      throw new Error("Invalid fill");
    if (
      side === "sell" &&
      quantity > this.sellable(key, day, settlementDays) + 1e-8
    )
      throw new Error("T+1 / insufficient inventory");
    const amount = big(moneyMul(quantity, price));
    const change = (side === "buy" ? amount.times(-1) : amount).minus(fee);
    // Research receipts can specify their original binary64 net settlement.
    // Reject a material mismatch; this never changes quantity, price or fees.
    if (
      settledCashChange !== undefined &&
      (!Number.isFinite(settledCashChange) ||
        Math.abs(toNumber(change) - settledCashChange) > 1e-8)
    )
      throw new Error("Settlement does not reconcile to fill");
    const next = toNumber(big(this.cash).plus(settledCashChange ?? change));
    if (next < -1e-8 || !Number.isFinite(next))
      throw new Error("Insufficient cash");
    this.cash = next;
    if (side === "buy") {
      const before = p?.quantity ?? 0;
      this.positions.set(key, {
        quantity: before + quantity,
        cost:
          ((p?.cost ?? 0) * before + quantity * price + fee) /
          (before + quantity),
        mark: price,
        bought: day,
        lots: [...(p?.lots ?? []), { quantity, bought: day }],
      });
    } else if (p) {
      let remaining = quantity;
      for (const lot of p.lots) {
        if (
          lot.availableOn !== undefined
            ? lot.availableOn > day
            : settlementDays !== 0 && lot.bought >= day
        )
          continue;
        const sold = Math.min(lot.quantity, remaining);
        lot.quantity -= sold;
        remaining -= sold;
      }
      p.lots = p.lots.filter((l) => l.quantity > 1e-10);
      p.quantity -= quantity;
      p.mark = price;
      if (p.quantity < 1e-10) this.positions.delete(key);
    }
  }
}

/** All replay profiles share the same ordered event clock. Policies supply
 * decisions at open/close; this function owns ordering, not market-specific rules.
 */
export function replayPortfolioEvents(
  dates: readonly string[],
  handlers: {
    beforeOpen?: (index: number, date: string) => void;
    open: (index: number, date: string) => void;
    close: (index: number, date: string) => void;
  },
) {
  let previous = "";
  dates.forEach((date, index) => {
    if (date <= previous || !Number.isFinite(Date.parse(date)))
      throw new Error("Invalid event calendar");
    previous = date;
    handlers.beforeOpen?.(index, date);
    handlers.open(index, date);
    handlers.close(index, date);
  });
}
