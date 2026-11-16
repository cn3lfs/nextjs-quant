import type Database from "better-sqlite3";
import type { StrategyBookDecision } from "trading-strategies";
import { sqlite } from "./index";
import type {
  PaperAccount,
  PaperFact,
  PaperFactKind,
  PaperState,
} from "../paper/model";

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
    const payload = JSON.stringify(fact.value);
    const previous = this.db
      .prepare(
        "SELECT payload FROM paper_facts WHERE account_id=? AND kind=? AND id=?",
      )
      .get(id, kind, fact.id) as { payload: string } | undefined;
    if (immutable && previous && previous.payload !== payload)
      throw new Error("纸面历史事实冲突；原始成交保留");
    this.db
      .prepare(
        "INSERT INTO paper_facts VALUES(?,?,?,?,?) ON CONFLICT(account_id,kind,id) DO UPDATE SET date=excluded.date,payload=excluded.payload",
      )
      .run(id, kind, fact.id, fact.date, payload);
  }
  clearPositions(id: string) {
    this.db
      .prepare("DELETE FROM paper_facts WHERE account_id=? AND kind='position'")
      .run(id);
  }
  page(id: string | undefined, kind: PaperFactKind, page = 0, day?: string) {
    if (!Number.isSafeInteger(page) || page < 0) throw new Error("无效页码");
    const args: (string | number)[] = [kind];
    let where = "kind=?";
    if (id) {
      where += " AND account_id=?";
      args.push(id);
    }
    if (day) {
      where += " AND substr(date,1,10)=?";
      args.push(day);
    }
    return this.atomic(() => {
      const total = (
        this.db
          .prepare(`SELECT count(*) n FROM paper_facts WHERE ${where}`)
          .get(...args) as { n: number }
      ).n;
      const rows = this.db
        .prepare(
          `SELECT account_id,id,date,payload FROM paper_facts WHERE ${where} ORDER BY date DESC,account_id,id LIMIT 20 OFFSET ?`,
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
