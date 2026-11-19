import {
  cashReviewInputIdentity,
  cashReviewVersion,
} from "../../db/cash-reconciliation-workspace";
import { DeliveryStore } from "../../db/delivery-store";
import { buildTradeReviewSnapshot } from "../../portfolio/trade-review-service";
import { fullLocalCalendarReference } from "../../market/data-health";
import { sqlite as chartSqlite } from "../../db";
import { settings } from "../../infra/settings";

// Paging, sorting and the sibling review queries all read one snapshot. Reuse
// it while account facts, settings and calendar identity are unchanged; the age
// limit picks up new local bars, RPS days and blocks. Callers only read it.
const REVIEW_TTL_MS = 60_000;
const reviewsByDatabase = new WeakMap<
  ReturnType<typeof chartSqlite>,
  Map<
    string,
    {
      key: string;
      at: number;
      value: ReturnType<typeof versionedAccountReview>;
    }
  >
>();
export function accountReview(account: string) {
  const db = chartSqlite();
  let reviews = reviewsByDatabase.get(db);
  if (!reviews) {
    reviews = new Map();
    reviewsByDatabase.set(db, reviews);
  }
  const cache = reviews;
  const now = Date.now();
  for (const [name, entry] of cache)
    if (now - entry.at >= REVIEW_TTL_MS) cache.delete(name);
  const key = cashReviewInputIdentity(db, account, settings());
  const hit = cache.get(account);
  if (hit && hit.key === key && now - hit.at < REVIEW_TTL_MS) return hit.value;
  const value = versionedAccountReview(account, key);
  cache.delete(account);
  // A snapshot includes full historical curves; retain only a few accounts.
  if (cache.size >= 4) cache.delete(cache.keys().next().value!);
  cache.set(account, { key, at: now, value });
  // A failed build is not reused.
  value.catch(() => {
    if (cache.get(account)?.value === value) cache.delete(account);
  });
  return value;
}
async function versionedAccountReview(account: string, inputIdentity: string) {
  const result = await computeAccountReview(account);
  if (
    cashReviewInputIdentity(chartSqlite(), account, settings()) !==
    inputIdentity
  )
    throw new Error("现金核对构建期间账户或日历已变化，请重试");
  return {
    ...result,
    cashVersion: cashReviewVersion(
      inputIdentity,
      result.calendar.hash,
      result.snapshot.cashReconciliation,
    ),
  };
}
async function computeAccountReview(account: string) {
  const config = settings();
  const calendar = await fullLocalCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  if (!calendar.days.length)
    throw new Error("交易日历不可用，请先配置交易日历或本地指数日线后重试");
  const db = chartSqlite();
  const store = new DeliveryStore(db);
  const dates = [
    ...store.fills(account).map((f) => f.tradeDate),
    ...store.cashFlows(account).map((f) => f.flowDate),
  ].sort();
  const start = dates[0];
  const end = dates.at(-1);
  if (!start || !end)
    throw new Error("该账户暂无可复盘的成交或资金流水，请先导入");
  if (calendar.days[0]! > start || calendar.days.at(-1)! < end)
    throw new Error(
      `交易日历未覆盖账户流水区间：日历实际覆盖 ${calendar.coverage.start} 至 ${calendar.coverage.end}，账户流水 ${start} 至 ${end}；日历共 ${calendar.coverage.count} 条；请补齐本地日历后重试`,
    );
  const tradingDays = calendar.days.filter((day) => day >= start && day <= end);
  if (!tradingDays.length) throw new Error("流水区间内没有可用交易日历");
  const snapshot = await buildTradeReviewSnapshot(
    {
      account,
      tdxRoot: config.tdxRoot,
      blocksRoot: config.industryBlocksRoot || undefined,
      tradingDays,
    },
    db,
  );
  return {
    snapshot,
    fullTradingDays: calendar.days,
    calendar: {
      source: calendar.source,
      hash: calendar.hash,
      coverage: calendar.coverage,
      start: tradingDays[0],
      end: tradingDays.at(-1),
    },
  };
}
