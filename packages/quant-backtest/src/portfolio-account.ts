import { big, moneyMul, toNumber } from "trading-strategy-core/money";

export type PortfolioLot = {
  quantity: number;
  bought: string;
  availableOn?: string;
};
function settlementInstant(date: string, settlementDays: 0 | 1) {
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(date);
  return Date.parse(
    zoned
      ? date
      : `${date.replace(" ", "T")}${settlementDays === 1 ? "+08:00" : "Z"}`,
  );
}
function settlementDate(date: string, settlementDays: 0 | 1) {
  if (date.length === 10) return date;
  return new Date(
    settlementInstant(date, settlementDays) +
      (settlementDays === 1 ? 8 * 3600000 : 0),
  )
    .toISOString()
    .slice(0, 10);
}
/** Default equity lots settle by Shanghai calendar day. Explicit entitlement
 * instants retain their finer boundary, including equivalent timezone labels. */
function lotAvailable(lot: PortfolioLot, date: string, settlementDays: 0 | 1) {
  if (lot.availableOn !== undefined) {
    // Preserve the legacy date-only replay contract when no intraday instant exists.
    if (date.length === 10) return lot.availableOn <= date;
    if (lot.availableOn.length === 10)
      return lot.availableOn <= settlementDate(date, settlementDays);
    return (
      settlementInstant(lot.availableOn, settlementDays) <=
      settlementInstant(date, settlementDays)
    );
  }
  return (
    settlementDays === 0 ||
    settlementDate(lot.bought, settlementDays) <
      settlementDate(date, settlementDays)
  );
}
export type PortfolioPosition = {
  quantity: number;
  cost: number;
  mark: number;
  lots: PortfolioLot[];
  bought: string;
};
export type PortfolioAction = {
  date: string;
  dividend: number;
  bonus: number;
  /** Split/consolidation multiplier, independent of bonus shares. */
  shareFactor?: number;
  rightsRatio?: number;
  rightsPrice?: number;
  evidence: string;
  availableAt: string;
  sharesSellableAt?: string;
};
export function actionPrice(price: number, action: PortfolioAction) {
  return (
    (price -
      action.dividend +
      (action.rightsRatio ?? 0) * (action.rightsPrice ?? 0)) /
    ((1 + action.bonus + (action.rightsRatio ?? 0)) * (action.shareFactor ?? 1))
  );
}
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
            n + (lotAvailable(lot, day, settlementDays) ? lot.quantity : 0),
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
  /** Research entitlement scenario: whole shares, no invented fractional cash.
   * Bonus availability is explicit; splits retain each lot's settlement lock. */
  corporateAction(key: string, action: PortfolioAction, wholeShares: boolean) {
    const p = this.positions.get(key);
    if (!p) return null;
    const before = p.quantity;
    const cash = moneyMul(before, action.dividend);
    const factor = action.shareFactor ?? 1;
    const theoretical = toNumber(
      big(before)
        .times(1 + action.bonus)
        .times(factor),
    );
    const quantity = wholeShares ? Math.floor(theoretical) : theoretical;
    const retained = toNumber(big(before).times(factor));
    const lots = p.lots.map((l) => ({
      ...l,
      quantity: toNumber(big(l.quantity).times(factor)),
    }));
    if (action.bonus > 0)
      lots.push({
        quantity: theoretical - retained,
        bought: action.date,
        availableOn: action.sharesSellableAt!,
      });
    // Round total entitlements once; distribute residual units by largest remainder.
    if (wholeShares) {
      const ranked = lots
        .map((l, i) => ({ i, remainder: l.quantity - Math.floor(l.quantity) }))
        .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
      let extra =
        quantity - lots.reduce((n, l) => n + Math.floor(l.quantity), 0);
      for (const l of lots) l.quantity = Math.floor(l.quantity);
      for (const r of ranked) if (extra-- > 0) lots[r.i]!.quantity++;
    }
    this.transfer(cash);
    const costBefore = p.cost;
    p.cost = quantity > 0 ? (before * p.cost - cash) / quantity : 0;
    p.quantity = quantity;
    p.mark = actionPrice(p.mark, action);
    p.lots = lots.filter((l) => l.quantity > 0);
    if (!quantity) this.positions.delete(key);
    return {
      before,
      quantity,
      cash,
      costBefore,
      costAfter: p.cost,
      markAfter: p.mark,
      fractionalShares: theoretical - quantity,
      rightsParticipation: "none" as const,
    };
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
        if (!lotAvailable(lot, day, settlementDays)) continue;
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
