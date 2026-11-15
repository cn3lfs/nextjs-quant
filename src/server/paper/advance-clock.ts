import { cryptoPeriodEnd } from "~/lib/market/crypto-aggregation";
import type { PaperAccount } from "./model";
export function paperCompletedAt(account: PaperAccount, date: string) {
  const period = account.candidates[0]!.strategy.period;
  return account.market === "crypto"
    ? cryptoPeriodEnd(date, period)
    : period === "day" || period === "week"
      ? Date.parse(`${date.slice(0, 10)}T15:00:00+08:00`)
      : Date.parse(date);
}
