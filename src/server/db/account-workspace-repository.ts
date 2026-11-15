import type Database from "better-sqlite3";
import { sqlite } from "./index";
import { DeliveryStore } from "./delivery-store";
import { TradeLedgerStore } from "./trade-ledger-store";
import { PaperRepository } from "./paper-repository";
import { AlertRepository } from "./alert-repository";
import { alertHistorySchema } from "~/lib/strategy-facts/alerts";
import type { TradeLink } from "~/lib/portfolio/account-workspace";
import type {
  AccountSnapshot,
  PlatformTrade,
} from "../crypto-trading/account-model";
import type { BotState } from "../crypto-trading/model";

export type AccountExpectation = {
  strategyId: string;
  version: number;
  strategyHash: string;
  source: string;
  horizon: 20;
  basis: "raw-entry-20-close";
  samples: number[];
  excluded: number;
  capturedAt: number;
  limitations: string[];
};
/** Links and their prior versions are owner-retained evidence, never evicted.
 * Trades, balances and paper checkpoints remain under their original owners. */
export class AccountWorkspaceRepository {
  constructor(readonly db: Database.Database = sqlite()) {}
  version() {
    const changes = this.db.prepare("SELECT total_changes() n").get() as {
      n: number;
    };
    return `${this.db.pragma("data_version", { simple: true })}:${changes.n}`;
  }
  assertVersion(version: string) {
    if (this.version() !== version)
      throw new Error("账户事实已更新，请刷新后重试");
  }
  atomic<T>(work: () => T) {
    return this.db.transaction(work).immediate();
  }
  records<T>(kind: string) {
    return (
      this.db
        .prepare("SELECT payload FROM records WHERE kind=? ORDER BY id")
        .all(kind) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as T);
  }
  record<T>(id: string): T | null {
    const r = this.db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return r ? (JSON.parse(r.payload) as T) : null;
  }
  snapshot() {
    return this.db.transaction(() => {
      const deliveries = new DeliveryStore(this.db),
        paper = new PaperRepository(this.db),
        alerts = new AlertRepository(this.db);
      const bots = this.records<BotState>("crypto-bot");
      return {
        version: this.version(),
        fills: deliveries.fills(),
        cashFlows: deliveries.cashFlows(),
        batches: deliveries.batches(),
        local: new TradeLedgerStore(this.db).trades(),
        paper: paper.ids().map((id) => ({
          account: paper.account(id)!,
          state: paper.state(id),
        })),
        crypto: bots.map((bot) => {
          const revision = this.record<string>(
            `crypto-account-credential-revision-${bot.id}`,
          );
          return {
            bot,
            revision,
            snapshot: revision
              ? this.record<AccountSnapshot>(
                  `crypto-account-snapshot-${bot.id}-${revision}`,
                )
              : null,
            trades: revision
              ? this.records<PlatformTrade>(
                  `crypto-account-trades-${bot.id}-${revision}`,
                )
              : [],
          };
        }),
        links: (
          this.db
            .prepare(
              "SELECT payload FROM account_trade_links ORDER BY trade_id",
            )
            .all() as { payload: string }[]
        ).map((r) => JSON.parse(r.payload) as TradeLink),
        expectations: (
          this.db
            .prepare(
              "SELECT payload FROM account_expectations ORDER BY strategy_id,version",
            )
            .all() as { payload: string }[]
        ).map((r) => JSON.parse(r.payload) as AccountExpectation),
        definitions: alerts.definitions(),
        plans: alerts.plans(),
        events: alerts.export(alertHistorySchema.parse({})),
      };
    })();
  }
  link(link: TradeLink) {
    this.db
      .prepare(
        "INSERT INTO account_link_audit(trade_id,linked_at,payload) VALUES(?,?,?)",
      )
      .run(link.tradeId, link.linkedAt, JSON.stringify(link));
    this.db
      .prepare(
        "INSERT INTO account_trade_links VALUES(?,?) ON CONFLICT(trade_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(link.tradeId, JSON.stringify(link));
    return link;
  }
  freezeExpectation(value: AccountExpectation) {
    const previous = this.db
      .prepare(
        "SELECT payload FROM account_expectations WHERE strategy_id=? AND version=?",
      )
      .get(value.strategyId, value.version) as { payload: string } | undefined;
    if (previous)
      throw new Error(
        "此策略版本已有冻结期望，保留首次证据；新参数请登记新版本",
      );
    this.db
      .prepare("INSERT INTO account_expectations VALUES(?,?,?)")
      .run(value.strategyId, value.version, JSON.stringify(value));
    return value;
  }
}
