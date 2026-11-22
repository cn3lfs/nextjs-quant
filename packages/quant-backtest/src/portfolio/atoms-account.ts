import {
  ExecutionLedger,
  formatDecimal,
  parseDecimal,
  type Atoms,
} from "quant-execution";
import { big, toNumber } from "trading-strategy-core/money";
import {
  actionPrice,
  type PortfolioAction,
  type PortfolioPosition,
} from "../portfolio-account.js";

export class AtomsPortfolioAccount {
  private readonly ledger: ExecutionLedger;
  readonly positions = new Map<string, PortfolioPosition>();
  private receiptId = 0;

  constructor(initial: number) {
    this.ledger = ExecutionLedger.forResearch(initial);
  }

  get cash() {
    return this.money(this.ledger.cash);
  }

  set cash(value: number) {
    if (!Number.isFinite(value)) throw new Error("Invalid cash transfer");
    const decimals = this.ledger.cashDecimals;
    const target = parseDecimal(big(value).toFixed(decimals), decimals);
    this.ledger.transferCash(target - this.ledger.cash);
  }

  get equity() {
    let value = big(formatDecimal(this.ledger.cash, this.ledger.cashDecimals));
    for (const position of this.positions.values())
      value = value.plus(big(position.quantity).times(position.mark));
    return toNumber(value);
  }

  sellable(key: string, day: string, settlementDays: 0 | 1) {
    return this.quantity(this.ledger.sellable(key, day, settlementDays));
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
    const prior = this.positions.get(key);
    this.ledger.applyReplayFill(
      {
        orderId: String(this.receiptId + 1),
        symbol: key,
        date: day,
        side,
        quantity,
        price,
        fee,
        settledCashChange,
      },
      settlementDays,
    );
    this.receiptId++;
    const position = this.ledger.position(key);
    const cost =
      side === "buy" && position
        ? ((prior?.cost ?? 0) * (prior?.quantity ?? 0) +
            quantity * price +
            fee) /
          this.quantity(position.quantity)
        : (prior?.cost ?? 0);
    this.project(
      key,
      position,
      cost,
      price,
      side === "buy" ? day : prior!.bought,
    );
  }

  corporateAction(
    key: string,
    action: PortfolioAction,
    wholeShares: boolean,
    dividendTaxBps = 0,
  ) {
    const prior = this.positions.get(key);
    const applied = this.ledger.applyResearchCorporateAction(
      key,
      action,
      wholeShares,
      dividendTaxBps,
    );
    if (!prior || !applied) return null;
    const { quantity: before, cost: costBefore, mark, bought } = prior;
    const quantity = this.quantity(applied.quantity);
    const cash = this.money(applied.cash);
    const costAfter =
      quantity > 0 ? (before * costBefore - cash) / quantity : 0;
    const markAfter = actionPrice(mark, action);
    this.project(key, this.ledger.position(key), costAfter, markAfter, bought);
    return {
      before,
      quantity,
      cash,
      costBefore,
      costAfter,
      markAfter,
      fractionalShares: applied.fractionalShares,
      rightsParticipation: "none" as const,
      ...(action.timingAssumption === undefined
        ? {}
        : {
            cashAvailableAt: action.cashAvailableAt,
            timingAssumption: action.timingAssumption,
          }),
    };
  }

  settlePendingCash(date: string) {
    return this.money(this.ledger.settlePendingCash(date));
  }

  transfer(amount: number) {
    if (!Number.isFinite(amount)) throw new Error("Invalid cash transfer");
    const decimals = this.ledger.cashDecimals;
    this.ledger.transferCash(
      parseDecimal(big(amount).toFixed(decimals), decimals),
    );
  }

  terminalValue(key: string, price: number) {
    const cash = this.ledger.settleTerminalValue(key, price);
    this.positions.delete(key);
    return this.money(cash);
  }

  private money(value: Atoms) {
    return Number(formatDecimal(value, this.ledger.cashDecimals));
  }

  private quantity(value: Atoms) {
    return Number(formatDecimal(value, this.ledger.quantityDecimals));
  }

  private project(
    key: string,
    position: ReturnType<ExecutionLedger["position"]>,
    cost: number,
    mark: number,
    bought: string,
  ) {
    if (!position) {
      // Callers hold the projection object to detect a full close after the
      // ledger removes the position; keep that reference truthful.
      const existing = this.positions.get(key);
      if (existing) existing.quantity = 0;
      this.positions.delete(key);
      return;
    }
    const next: PortfolioPosition = {
      quantity: this.quantity(position.quantity),
      cost,
      mark,
      bought,
      lots: position.lots.map((lot) => ({
        quantity: this.quantity(lot.quantity),
        bought: lot.acquiredAt,
        // Purchased lots use the replay settlement rule. Zero-price ledger
        // lots are the bonus entitlements with a separately evidenced unlock.
        ...(lot.price === 0n ? { availableOn: lot.sellableAt } : {}),
      })),
    };
    const existing = this.positions.get(key);
    if (existing) Object.assign(existing, next);
    else this.positions.set(key, next);
  }
}
