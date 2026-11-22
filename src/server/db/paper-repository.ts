import type Database from "better-sqlite3";
import type { StrategyBookDecision } from "trading-strategies";
import { isDeepStrictEqual } from "node:util";
import { sqlite } from "./index";
import type {
  PaperAccount,
  PaperAdvanceEvent,
  PaperFact,
  PaperFactKind,
  PaperOrderEvent,
  PaperState,
} from "../paper/model";

const orderEventKey = (accountId: string, id: string) =>
  `paper-order-event:${Buffer.from(accountId, "utf8").toString("hex").toUpperCase()}:${id}`;

/** First-observed inputs and executions are retained until explicit owner deletion.
 * Mutable projections and the replay checkpoint commit under one revision fence. */
export class PaperRepository {
  constructor(readonly db: Database.Database = sqlite()) {}
  /** Parse one checkpoint once, then keep only one completed bar's genuine
   * observations for all its symbols/strategies. Callers cache this projection
   * for an evaluation cycle; never parse a large checkpoint per symbol. */
  watchContext(id: string, date: string) {
    const state = this.state(id);
    if (
      !state ||
      !state.request.calendar.includes(date) ||
      date < state.request.start ||
      date > state.request.end
    )
      return null;
    const instruments = new Map(
      state.request.instruments.map((instrument) => {
        const raw = instrument.bars.find((bar) => bar.date === date);
        const signal = instrument.signalBars.find((bar) => bar.date === date);
        return [
          instrument.symbol,
          {
            symbol: instrument.symbol,
            market: instrument.market,
            rawBars: instrument.external?.preparedRules
              ? raw
                ? [raw]
                : []
              : instrument.bars.filter((bar) => bar.date <= date),
            bars: instrument.external?.preparedRules
              ? signal
                ? [signal]
                : []
              : instrument.signalBars.filter((bar) => bar.date <= date),
            external: {
              ...instrument.external,
              preparedRules: instrument.external?.preparedRules?.map(
                (rule) => ({
                  ...rule,
                  points: rule.points.filter((point) => point.date === date),
                }),
              ),
              rps: instrument.external?.rps?.filter((point) =>
                instrument.external?.preparedRules
                  ? point.date === date
                  : point.date <= date,
              ),
            },
          },
        ] as const;
      }),
    );
    return {
      strategies: state.request.strategies,
      decisions:
        state.result.bookDecisions?.filter(
          (row) => row.decision.date === date,
        ) ?? [],
      memberships:
        state.request.memberships?.filter((row) => row.date === date) ?? [],
      instruments,
      source: `Frozen paper ${id}; genuine completed rule ${date}`,
    };
  }
  bookDecision(id: string, strategyId: string, version: number, date: string) {
    const rows = this.db
      .prepare(
        `SELECT json_extract(b.value,'$.decision') decision
      FROM paper_state p,json_each(p.payload,'$.request.strategies') s,json_each(p.payload,'$.result.bookDecisions') b
      WHERE p.account_id=? AND json_extract(s.value,'$.id')=? AND json_extract(s.value,'$.version')=?
      AND json_extract(b.value,'$.strategyId')=? AND json_extract(b.value,'$.decision.date')=?`,
      )
      .all(id, strategyId, version, strategyId, date) as { decision: string }[];
    if (rows.length !== 1) return null;
    return JSON.parse(rows[0]!.decision) as StrategyBookDecision;
  }
  sizingPolicy(id: string, strategyId: string, symbol: string, date: string) {
    const row = this.db
      .prepare(
        "SELECT json_extract(payload,'$.request.sleeves') sleeves,json_extract(payload,'$.request.costs') costs FROM paper_state WHERE account_id=?",
      )
      .get(id) as { sleeves: string; costs: string | null } | undefined;
    if (!row) return null;
    const weight = this.db
      .prepare(
        `SELECT json_extract(w.value,'$.weight') weight FROM paper_state p,json_each(p.payload,'$.request.positionWeights') w
      WHERE p.account_id=? AND json_extract(w.value,'$.strategyId')=? AND json_extract(w.value,'$.symbol')=?
      AND json_extract(w.value,'$.date')=? AND json_extract(w.value,'$.availableAt')<=?`,
      )
      .get(id, strategyId, symbol, date, date) as
      { weight: number } | undefined;
    return {
      sleeves: JSON.parse(row.sleeves) as PaperState["request"]["sleeves"],
      costs: row.costs
        ? (JSON.parse(row.costs) as PaperState["request"]["costs"])
        : undefined,
      weight: weight?.weight,
    };
  }
  atomic<T>(work: () => T) {
    return this.db.transaction(work).immediate();
  }
  account(id: string): PaperAccount | null {
    const row = this.db
      .prepare("SELECT payload FROM paper_accounts WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as PaperAccount) : null;
  }
  ids() {
    return (
      this.db.prepare("SELECT id FROM paper_accounts ORDER BY id").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
  }
  summaries() {
    return (
      this.db
        .prepare(
          `SELECT json_remove(payload,'$.candidates') payload FROM paper_accounts ORDER BY market,sleeve,id`,
        )
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as Omit<PaperAccount, "candidates">);
  }
  create(account: PaperAccount) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO paper_accounts VALUES(?,?,?,?,?,?)")
        .run(
          account.id,
          account.market,
          account.sleeve,
          account.startedAt,
          account.revision,
          JSON.stringify(account),
        ).changes === 1
    );
  }
  regroupEmptyAccounts() {
    if (
      this.db.prepare("SELECT 1 FROM paper_state LIMIT 1").get() ||
      this.db.prepare("SELECT 1 FROM paper_facts LIMIT 1").get() ||
      this.summaries().some((a) => a.mirror.venue !== "off")
    )
      throw new Error("账户已有记账或镜像，不能更改合账方式");
    this.db.prepare("DELETE FROM paper_accounts").run();
  }
  save(account: PaperAccount, expectedRevision: number) {
    const next = { ...account, revision: expectedRevision + 1 };
    if (
      this.db
        .prepare(
          "UPDATE paper_accounts SET payload=?,revision=? WHERE id=? AND revision=?",
        )
        .run(JSON.stringify(next), next.revision, account.id, expectedRevision)
        .changes !== 1
    )
      throw new Error("纸面账户已更新，请重新读取");
    return next;
  }
  state(id: string): PaperState | null {
    const row = this.db
      .prepare("SELECT payload FROM paper_state WHERE account_id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as PaperState) : null;
  }
  saveState(id: string, state: PaperState) {
    const payload = JSON.stringify(state);
    if (Buffer.byteLength(payload) > 128 * 1024 ** 2)
      throw new Error("纸面账户冻结输入超过128MiB；保留原事实，停止推进");
    this.db
      .prepare(
        "INSERT INTO paper_state VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(id, payload);
  }
  fact(id: string, kind: PaperFactKind, fact: PaperFact, immutable = false) {
    if (kind === "order-event") {
      // paper_facts.kind has a fixed SQLite CHECK. The existing records table
      // stores this append-only fact under an account-scoped key.
      const key = orderEventKey(id, fact.id);
      const payload = JSON.stringify({ accountId: id, ...fact });
      const inserted = this.db
        .prepare(
          "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
        )
        .run(key, kind, payload, Date.now());
      if (inserted.changes) return;
      const previous = this.db
        .prepare("SELECT kind,payload FROM records WHERE id=?")
        .get(key) as { kind: string; payload: string };
      if (previous.kind !== kind || previous.payload !== payload)
        throw new Error(`纸面历史事实冲突，原记录已保留（${kind} ${fact.id}）`);
      return;
    }
    const payload = JSON.stringify(fact.value);
    if (immutable || kind === "order") {
      const inserted = this.db
        .prepare(
          "INSERT INTO paper_facts VALUES(?,?,?,?,?) ON CONFLICT(account_id,kind,id) DO NOTHING",
        )
        .run(id, kind, fact.id, fact.date, payload);
      if (inserted.changes) return;
      const previous = this.db
        .prepare(
          "SELECT date,payload FROM paper_facts WHERE account_id=? AND kind=? AND id=?",
        )
        .get(id, kind, fact.id) as { date: string; payload: string };
      if (previous.date !== fact.date || previous.payload !== payload)
        throw new Error(`纸面历史事实冲突，原记录已保留（${kind} ${fact.id}）`);
      return;
    }
    this.db
      .prepare(
        "INSERT INTO paper_facts VALUES(?,?,?,?,?) ON CONFLICT(account_id,kind,id) DO UPDATE SET date=excluded.date,payload=excluded.payload",
      )
      .run(id, kind, fact.id, fact.date, payload);
  }
  observeOrder(
    id: string,
    event: PaperAdvanceEvent,
    order: PaperOrderEvent["order"],
  ) {
    const orderId = String(order.id);
    const original = this.factValue<PaperOrderEvent["order"]>(
      id,
      "order",
      orderId,
    );
    if (!original) {
      this.fact(
        id,
        "order",
        { id: orderId, date: order.signalAt, value: order },
        true,
      );
      return;
    }
    const row = this.db
      .prepare(
        `SELECT json_extract(payload,'$.value') AS payload FROM records
        WHERE kind='order-event' AND id>=? AND id<?
        ORDER BY id DESC LIMIT 1`,
      )
      .get(
        orderEventKey(id, `${orderId}:`),
        orderEventKey(id, `${orderId};`),
      ) as { payload: string } | undefined;
    const latest = row
      ? (JSON.parse(row.payload) as PaperOrderEvent).order
      : original;
    const identity = ({
      strategyId,
      sleeve,
      symbol,
      side,
      signalAt,
      trigger,
    }: PaperOrderEvent["order"]) => [
      strategyId,
      sleeve,
      symbol,
      side,
      signalAt,
      trigger,
    ];
    if (!isDeepStrictEqual(identity(original), identity(order)))
      throw new Error(`纸面历史订单身份冲突，原记录已保留（${orderId}）`);
    const snapshot = JSON.parse(
      JSON.stringify(order),
    ) as PaperOrderEvent["order"];
    if (isDeepStrictEqual(latest, snapshot)) return;
    const reason =
      order.reason ??
      (order.status === "filled" && latest.status !== "filled"
        ? "订单已成交"
        : "撮合更新订单快照");
    this.fact(
      id,
      "order-event",
      {
        // The fixed width preserves numeric sequence ordering in the SQLite key.
        id: `${orderId}:${String(event.sequence).padStart(16, "0")}`,
        date: event.cutoff,
        value: {
          orderId: order.id,
          sequence: event.sequence,
          reason,
          order: snapshot,
        } satisfies PaperOrderEvent,
      },
      true,
    );
  }
  clearPositions(id: string) {
    this.db
      .prepare("DELETE FROM paper_facts WHERE account_id=? AND kind='position'")
      .run(id);
  }
  page(id: string | undefined, kind: PaperFactKind, page = 0, day?: string) {
    if (!Number.isSafeInteger(page) || page < 0) throw new Error("无效页码");
    const args: (string | number)[] = [kind];
    let where = "f.kind=?";
    if (id) {
      where += " AND f.account_id=?";
      args.push(id);
    }
    if (day) {
      where += " AND substr(f.date,1,10)=?";
      args.push(day);
    }
    const facts =
      kind === "order-event"
        ? `(SELECT a.id AS account_id, r.kind, json_extract(r.payload,'$.id') AS id,
             json_extract(r.payload,'$.date') AS date, json_extract(r.payload,'$.value') AS payload
           FROM records r JOIN paper_accounts a ON a.id=json_extract(r.payload,'$.accountId')
           WHERE r.kind='order-event')`
        : "paper_facts";
    return this.atomic(() => {
      const total = (
        this.db
          .prepare(`SELECT count(*) n FROM ${facts} f WHERE ${where}`)
          .get(...args) as { n: number }
      ).n;
      const payload =
        kind === "order"
          ? `COALESCE(
              (SELECT json_extract(e.payload,'$.value.order') FROM records e
               WHERE e.kind='order-event'
                 AND e.id>='paper-order-event:'||hex(f.account_id)||':'||f.id||':'
                 AND e.id<'paper-order-event:'||hex(f.account_id)||':'||f.id||';'
               ORDER BY e.id DESC LIMIT 1),
              f.payload)`
          : "f.payload";
      const rows = this.db
        .prepare(
          `SELECT f.account_id,f.id,f.date,${payload} AS payload FROM ${facts} f WHERE ${where}
           ORDER BY f.date DESC,f.account_id,f.id LIMIT 20 OFFSET ?`,
        )
        .all(...args, page * 20) as {
        account_id: string;
        id: string;
        date: string;
        payload: string;
      }[];
      return {
        total,
        items: rows.map((r) => ({
          account: r.account_id,
          id: r.id,
          date: r.date,
          value: JSON.parse(r.payload) as Record<string, unknown>,
        })),
      };
    });
  }
  factValue<T>(id: string, kind: PaperFactKind, key: string): T | null {
    if (kind === "order-event") {
      const row = this.db
        .prepare(
          "SELECT json_extract(payload,'$.value') AS payload FROM records WHERE kind=? AND id=?",
        )
        .get(kind, orderEventKey(id, key)) as { payload: string } | undefined;
      return row ? (JSON.parse(row.payload) as T) : null;
    }
    const row = this.db
      .prepare(
        "SELECT payload FROM paper_facts WHERE account_id=? AND kind=? AND id=?",
      )
      .get(id, kind, key) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  }
  mirrorOwner(venue: string, network: string, except: string) {
    return this.db
      .prepare(
        "SELECT id FROM paper_accounts WHERE json_extract(payload,'$.mirror.venue')=? AND json_extract(payload,'$.mirror.network')=? AND id<>? LIMIT 1",
      )
      .get(venue, network, except) as { id: string } | undefined;
  }
  mirrorRecords<T>(id: string) {
    return (
      this.db
        .prepare(
          "SELECT payload FROM paper_facts WHERE account_id=? AND kind='mirror' ORDER BY date,CAST(substr(id,instr(id,':')+1) AS INTEGER),id",
        )
        .all(id) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as T);
  }
}
