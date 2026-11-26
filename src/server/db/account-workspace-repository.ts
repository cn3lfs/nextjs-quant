import Database from "better-sqlite3";
import { statSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory, sqlite } from "./index";
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
import type { CorporateEvidence } from "~/lib/portfolio/trade-ledger";
import { readMockCache } from "../portfolio/account-workspace/mock-cache";
import type { MockResponseEvidence } from "../portfolio/mock/mock-trading";
import type { FuturesSimAccountSummary } from "~/lib/portfolio/futures-sim";
import {
  positionView,
  replayPositions,
} from "../portfolio/sim-accounts/engine";
import { SimAccountRepository } from "./sim-account-repository";

export function openAccountWorkspaceRead() {
  const path = join(dataDirectory(), "quant.sqlite");
  if (!statSync(path, { throwIfNoEntry: false }))
    return { repo: null, close: () => {} };
  const db = new Database(path, { readonly: true, fileMustExist: true });
  return { repo: new AccountWorkspaceRepository(db), close: () => db.close() };
}

type MockOrderCache = {
  state: "pending" | "attempted" | "accepted" | "unknown" | "blocked";
  input: { date: string };
  receipt?: { entrustNos: string[]; at: number; tradeDate: string };
};

type AccountFacts = ReturnType<AccountWorkspaceRepository["snapshot"]>;

export function emptyAccountFacts(): AccountFacts {
  return {
    version: "empty",
    fills: [],
    cashFlows: [],
    batches: [],
    local: [],
    paper: [],
    crypto: [],
    localSim: [],
    futuresSim: [],
    thsMock: null,
    links: [],
    expectations: [],
    expectationStatuses: [],
    definitions: [],
    plans: [],
    events: [],
  };
}

export type AccountExpectation = {
  strategyId: string;
  version: number;
  strategyHash: string;
  definitionHash?: string;
  inputHash?: string;
  resultHash?: string;
  buildHash?: string;
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
  expectation(strategyId: string, version: number) {
    const row = this.db
      .prepare(
        "SELECT payload FROM account_expectations WHERE strategy_id=? AND version=?",
      )
      .get(strategyId, version) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as AccountExpectation) : null;
  }
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
  bonusListings() {
    const rows = this.db
      .prepare<[], { id: string; payload: string }>(
        "SELECT id,payload FROM records WHERE id>='trade-bonus-' AND id<'trade-bonus.'",
      )
      .all();
    return new Map(
      rows.map(({ id, payload }) => [
        id.slice("trade-bonus-".length),
        JSON.parse(payload) as NonNullable<CorporateEvidence["bonusListings"]>,
      ]),
    );
  }
  thsMockMetadata(at: number) {
    const config = this.db
      .prepare<[], { payload: string; updated_at: number }>(
        "SELECT payload,updated_at FROM records WHERE id='mock-trading-config' AND kind='mock-trading-config'",
      )
      .get();
    const diagnostics =
      this.record<MockResponseEvidence[]>("mock-diagnostics") ?? [];
    const orders = this.db
      .prepare<[], { id: string; payload: string; updated_at: number }>(
        "SELECT id,payload,updated_at FROM records WHERE kind='mock-order' ORDER BY updated_at,id",
      )
      .all();
    if (!config && !diagnostics.length && !orders.length) return null;
    const receipts = orders.map(({ id, payload, updated_at }) => {
      const order = JSON.parse(payload) as MockOrderCache;
      return {
        id,
        state: order.state,
        updatedAt: updated_at,
        tradeDate: order.receipt?.tradeDate ?? order.input.date,
        acceptedAt: order.receipt?.at ?? null,
        entrustNos: order.receipt?.entrustNos ?? [],
      };
    });
    return {
      kind: "ths-mock" as const,
      account: "default",
      accountName: "同花顺模拟盘",
      market: "cn-equity" as const,
      enabled: config
        ? (JSON.parse(config.payload) as { enabled: boolean }).enabled
        : null,
      configuredAt: config?.updated_at ?? null,
      diagnostics: diagnostics.map(({ path, httpStatus, envelope }) => ({
        path,
        httpStatus,
        fetchedAt: envelope.fetchedAt,
        quality: envelope.quality,
        payloadHash: envelope.payloadHash,
      })),
      ...readMockCache(diagnostics, receipts, at),
      orders: receipts,
    };
  }
  snapshot(at = Date.now()) {
    return this.db.transaction(() => {
      const deliveries = new DeliveryStore(this.db),
        paper = new PaperRepository(this.db),
        alerts = new AlertRepository(this.db);
      const bots = this.records<BotState>("crypto-bot");
      return {
        version: this.version(),
        fills: deliveries.fills(),
        cashFlows: deliveries.cashFlows(),
        batches: deliveries.batches(false),
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
        localSim: this.localSimAccounts(at),
        futuresSim: this.records<FuturesSimAccountSummary>(
          "futures-sim-account",
        ),
        thsMock: this.thsMockMetadata(at),
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
        expectationStatuses: this.records<{
          definitionHash: string;
          status: string;
          reason?: string;
        }>("account-expectation-status"),
        definitions: alerts.definitions(),
        plans: alerts.plans(),
        events: alerts.export(alertHistorySchema.parse({})),
      };
    })();
  }
  private localSimAccounts(at: number) {
    const repo = new SimAccountRepository(this.db);
    return repo.list().map((account) => {
      const row = repo.account(account.id);
      const today = new Date(
        at + (account.market === "crypto" ? 0 : 8 * 3600000),
      )
        .toISOString()
        .slice(0, 10);
      const latest = repo.latestDate(account.id);
      const holdings = replayPositions(
        repo.fills(account.id),
        account.market,
        latest && latest > today ? latest : today,
      );
      return {
        account,
        trades: repo.trades(row, undefined, -1).reverse(),
        positions: Array.from(holdings, ([symbol, holding]) =>
          positionView(symbol, holding, account.market),
        ),
      };
    });
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
  hasSymbolInTable(
    table: "trade_ledger" | "sim_fills" | "trade_fills",
    symbol: string,
  ) {
    return (
      this.db
        .prepare(`SELECT 1 FROM ${table} WHERE symbol=? LIMIT 1`)
        .get(symbol) !== undefined
    );
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
