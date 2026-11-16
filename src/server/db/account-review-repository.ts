import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { sqlite } from "./index";
import { NotificationPolicyStore } from "./notification-policy-store";
import type { TradeJournal } from "~/lib/portfolio/account-review";
import type { HoldingProtectionProjection } from "~/lib/portfolio/holding-protection";

/** Review metadata never rewrites source fills or their provenance. */
export class AccountReviewRepository {
  readonly records: NotificationPolicyStore;
  constructor(readonly db: Database.Database = sqlite()) {
    this.records = new NotificationPolicyStore(db);
  }
  journals() {
    return this.records.all<TradeJournal>("account-trade-journal");
  }
  journal(tradeId: string) {
    return (
      this.records.read<TradeJournal>(`account-journal:${tradeId}`) ?? null
    );
  }
  saveJournal(value: TradeJournal) {
    const previous = this.journal(value.tradeId);
    this.records.save(
      "account-journal-audit",
      `account-journal-audit:${randomUUID()}`,
      { previous, current: value },
    );
    return this.records.save(
      "account-trade-journal",
      `account-journal:${value.tradeId}`,
      value,
    );
  }
  protectionSnapshots(
    planId: string,
    account: string,
    at: number,
    kind: string,
    market: string,
    symbol: string,
  ) {
    return (
      this.db
        .prepare(
          `SELECT payload FROM records WHERE kind='alert-state' AND id LIKE 'alerts:protection-snapshot:%'
      AND json_extract(payload,'$.task.sourcePlanId')=? AND json_extract(payload,'$.task.account')=?
      AND json_extract(payload,'$.observedAt')<? AND json_extract(payload,'$.task.kind')=? AND json_extract(payload,'$.task.market')=? AND json_extract(payload,'$.task.symbol')=? ORDER BY json_extract(payload,'$.observedAt') DESC,id DESC LIMIT 1`,
        )
        .all(planId, account, at, kind, market, symbol) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as HoldingProtectionProjection);
  }
  completedValidationJobs(strategyId: string, version: number) {
    return (
      this.db
        .prepare(
          `SELECT id,payload FROM records WHERE kind='job' AND json_extract(payload,'$.status')='completed'
      AND ((json_extract(payload,'$.result.frozen.request.strategies[0].id')=? AND json_extract(payload,'$.result.frozen.request.strategies[0].version')=?)
      OR (json_extract(payload,'$.result.frozen.strategyObject.id')=? AND json_extract(payload,'$.result.frozen.strategyObject.version')=?)) ORDER BY updated_at DESC,id DESC LIMIT 20`,
        )
        .all(strategyId, version, strategyId, version) as {
        id: string;
        payload: string;
      }[]
    ).map((r) => ({
      id: r.id,
      job: JSON.parse(r.payload) as { status: string; result: unknown },
    }));
  }
}
