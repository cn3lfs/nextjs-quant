import { AccountBook } from "./account-book.js";
import { lotAvailable } from "./settlement.js";
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
export class ResearchExecutionLedger extends AccountBook<
  number,
  PortfolioLot,
  PortfolioPosition
> {
  constructor(initial: number) {
    if (!Number.isFinite(initial) || initial <= 0)
      throw new Error("Invalid initial cash");
    super(initial, {
      zero: 0,
      add: (a, b) => a + b,
      subtract: (a, b) => a - b,
      keepLot: (q) => q > 1e-10,
      keepPosition: (q) => q >= 1e-10,
    });
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
  private transferredCash(amount: number) {
    const next = toNumber(big(this.cash).plus(amount));
    if (!Number.isFinite(amount) || next < -1e-8)
      throw new Error("Invalid cash transfer");
    return next;
  }
  transfer(amount: number) {
    this.cash = this.transferredCash(amount);
  }
  /** Research entitlement scenario: whole shares, no invented fractional cash.
   * Bonus availability is explicit; splits retain each lot's settlement lock. */
  corporateAction(
    key: string,
    action: PortfolioAction,
    wholeShares: boolean,
    dividendTaxBps = 0,
  ) {
    const p = this.positions.get(key);
    if (!p) return null;
    const before = p.quantity;
    const cash = moneyMul(
      moneyMul(before, action.dividend),
      1 - dividendTaxBps / 10000,
    );
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
    const costBefore = p.cost;
    this.postAction(key, p, this.transferredCash(cash), {
      cost: quantity > 0 ? (before * costBefore - cash) / quantity : 0,
      quantity,
      mark: actionPrice(p.mark, action),
      lots: lots.filter((l) => l.quantity > 0),
    });
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
    this.postFill(
      key,
      side,
      quantity,
      price,
      next,
      (lot) => lotAvailable(lot, day, settlementDays),
      () => ({ quantity, bought: day }),
      (prior, total, lots) => ({
        quantity: total,
        mark: price,
        bought: day,
        lots,
        cost:
          ((prior?.cost ?? 0) * (prior?.quantity ?? 0) +
            quantity * price +
            fee) /
          total,
      }),
      (prior) => prior.cost,
    );
  }
}
