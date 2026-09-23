import type { ReviewValue } from "./trade-review";

/** Shared R12 price-scale evidence and U4 day VWAP; never substitute close. */
export function tradeReviewDayVwap(bar: {
  amount: number;
  volume: number;
}): ReviewValue {
  if (!Number.isFinite(bar.volume) || bar.volume <= 0)
    return { value: null, reason: "当日成交量非正或无效" };
  if (!Number.isFinite(bar.amount) || bar.amount <= 0)
    return { value: null, reason: "当日成交额非正或无效" };
  const value = bar.amount / bar.volume;
  return Number.isFinite(value) && value > 0
    ? { value, reason: null }
    : { value: null, reason: "当日 VWAP 非正或溢出" };
}
