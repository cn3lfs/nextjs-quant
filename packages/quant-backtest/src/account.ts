import { big, bpsOf, moneyMul, toNumber } from "trading-strategy-core/money";
import { commissionFor } from "./execution.js";
import type { ExecutionCosts } from "./costs.js";
import type { CashEquityAccount } from "./model.js";

export function canSellTPlusOne(account: CashEquityAccount, day: string) {
  return account.shares > 0 && account.buyDay < day;
}
/** Only fills change cash or shares; signals and pending orders never do. */
export function bookFill(
  account: CashEquityAccount,
  side: "buy" | "sell",
  price: number,
  quantity: number,
  day: string,
  costs: ExecutionCosts,
) {
  const amount = moneyMul(quantity, price);
  const fee = toNumber(
    big(commissionFor(amount, costs)).plus(
      side === "sell" ? bpsOf(amount, costs.sellTaxBps) : 0,
    ),
  );
  const nextCash =
    side === "buy"
      ? toNumber(big(account.cash).minus(amount).minus(fee))
      : toNumber(big(account.cash).plus(amount).minus(fee));
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    (side === "sell" && quantity > account.shares) ||
    nextCash < -1e-8 ||
    !Number.isFinite(nextCash)
  )
    throw new Error("账户现金或成交数量非法");
  account.cash = nextCash;
  account.shares += side === "buy" ? quantity : -quantity;
  if (side === "buy") account.buyDay = day;
  return fee;
}
