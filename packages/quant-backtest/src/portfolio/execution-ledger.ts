import { atomsFrom, type ExecutionLedger, type Fill } from "quant-execution";
import { big } from "trading-strategy-core/money";

/** Import a priced fill with a known fee breakdown. The caller owns sizing and
 * matching. Reject sub-atom inputs so parity cannot hide cumulative rounding. */
export function postPortfolioFill(
  ledger: ExecutionLedger,
  receipt: {
    orderId: string;
    symbol: string;
    date: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    commission: number;
    transfer?: number;
    tax?: number;
    settledCashChange?: number;
  },
  settlementDays: 0 | 1,
): Fill {
  const market = ledger.market;
  const money = (value: number) =>
    atomsFrom(market, big(value).toFixed(), "money");
  const grossDecimal = big(receipt.quantity).times(receipt.price);
  const gross = atomsFrom(market, grossDecimal.toFixed(), "money");
  const commission = money(receipt.commission);
  const transfer = money(receipt.transfer ?? 0);
  const tax = money(receipt.tax ?? 0);
  const cashDelta =
    (receipt.side === "buy" ? -gross : gross) - commission - transfer - tax;
  if (receipt.settledCashChange !== undefined) {
    if (
      !Number.isFinite(receipt.settledCashChange) ||
      money(receipt.settledCashChange) !== cashDelta
    )
      throw new Error("Settlement does not reconcile to fill");
  }
  const fill: Fill = {
    orderId: receipt.orderId,
    symbol: receipt.symbol,
    date: receipt.date,
    side: receipt.side,
    quantity: atomsFrom(market, big(receipt.quantity).toFixed(), "quantity"),
    price: atomsFrom(market, big(receipt.price).toFixed(), "price"),
    gross,
    commission,
    transfer,
    tax,
    cashDelta,
  };
  ledger.applyReplayFill(fill, settlementDays);
  return fill;
}
