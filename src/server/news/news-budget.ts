import { atomic, get, put } from "../db";
import { settings } from "../infra/settings";

export function newsBudget(now = Date.now()) {
  const day = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
  const key = `news-budget-${day}`;
  const used = get<{ used: number }>(key)?.used ?? 0;
  const limit = settings().autoNewsDailyBatches;
  const resetAt = Date.parse(`${day}T00:00:00+08:00`) + 86400000;
  return { key, day, used, limit, resetAt, exhausted: used >= limit };
}

export function reserveNewsBatch() {
  return atomic(() => {
    const budget = newsBudget();
    if (budget.exhausted)
      throw new Error(
        "自动新闻研究已达到每日AI批次上限，次日恢复；手动研究不受此限制。",
      );
    // Charge before the request: failures and process crashes must not refund
    // work which may already have consumed the subscription's allowance.
    put("news-budget", budget.key, { used: budget.used + 1 });
  });
}
