import type Database from "better-sqlite3";
import {
  StrategyRepository,
  tradePlanSchema,
  watchEventSchema,
  type TradePlan,
} from "./strategy-repository";
import { NotificationPolicyStore } from "./notification-policy-store";
import { sqlite } from "./index";
import { RpsStore } from "./rps-store";
import type { StrategyObjectInput } from "trading-strategies";
import type { Period } from "~/lib/domain";
import type {
  AlertEvent,
  AlertHistoryInput,
  AlertSubscription,
} from "~/lib/strategy-facts/alerts";
import { alertKey, legacyAlertKeys } from "~/lib/strategy-facts/alerts";
import type { Outcome } from "~/lib/strategy-facts/signal-ledger";

/** First observations and settled outcomes are immutable. Evidence is retained until explicit owner deletion. */
export class AlertRepository {
  readonly records: NotificationPolicyStore;
  readonly strategies: StrategyRepository;
  constructor(readonly db: Database.Database = sqlite()) {
    this.records = new NotificationPolicyStore(db);
    this.strategies = new StrategyRepository(db);
  }
  atomic<T>(action: () => T) {
    return this.db.transaction(action).immediate();
  }
  state<T>(id: string) {
    return this.records.read<T>(`alerts:${id}`);
  }
  saveState<T>(id: string, value: T) {
    return this.records.save("alert-state", `alerts:${id}`, value);
  }
  dataGaps() {
    const prefix = "alerts:data-gap:";
    const rows = this.db
      .prepare(
        "SELECT id,payload FROM records WHERE kind='alert-state' AND substr(id,1,?)=? AND json_extract(payload,'$.reason') IS NOT NULL AND coalesce(json_extract(payload,'$.resolved'),0)<>1 ORDER BY json_extract(payload,'$.at') DESC,id LIMIT 20",
      )
      .all(prefix.length, prefix) as { id: string; payload: string }[];
    return rows.map((r) => ({
      id: r.id.slice(prefix.length),
      ...(JSON.parse(r.payload) as {
        at: number;
        reason: string;
        period?: string;
      }),
    }));
  }
  subscriptions() {
    return this.records.all<AlertSubscription>("alert-subscription");
  }
  definitions() {
    return (
      this.db
        .prepare("SELECT payload FROM strategies ORDER BY id,version")
        .all() as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as StrategyObjectInput);
  }
  liveStrategies() {
    return this.definitions().filter(
      (s) =>
        this.state<{ live: boolean }>(`strategy:${s.id}:${s.version}`)?.live,
    );
  }
  watchedStrategies() {
    return this.definitions().filter(
      (s) =>
        this.state<{ live: boolean }>(`strategy:${s.id}:${s.version}`)?.live ||
        this.state<{ active: boolean }>(`shadow:${s.id}:${s.version}`)?.active,
    );
  }
  event(key: string): AlertEvent | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM watch_events WHERE dedupe_key=? AND json_type(payload,'$.observedAt')='integer'",
      )
      .get(key) as { payload: string } | undefined;
    return row
      ? this.withOutcomes(JSON.parse(row.payload) as AlertEvent)
      : null;
  }
  record(
    strategy: StrategyObjectInput,
    event: AlertEvent,
    effects: (committed: AlertEvent) => void = () => {},
  ) {
    if (
      event.strategyId !== strategy.id ||
      event.version !== strategy.version ||
      event.market !== strategy.market ||
      event.sleeve !== strategy.sleeve ||
      event.key !== alertKey(event)
    )
      throw new Error("Alert strategy identity mismatch");
    return this.db
      .transaction(() => {
        this.strategies.saveStrategy(strategy);
        const lookup = this.db.prepare(
          "SELECT payload,plan_id FROM watch_events WHERE dedupe_key=?",
        );
        type Prior = { payload: string; plan_id: string | null };
        let key = event.key;
        let prior = lookup.get(key) as Prior | undefined;
        if (!prior) {
          for (const legacy of legacyAlertKeys(event)) {
            const candidate = lookup.get(legacy) as Prior | undefined;
            if (!candidate) continue;
            const old = JSON.parse(candidate.payload) as AlertEvent;
            if (
              old.type !== event.type ||
              old.paperFillId !== event.paperFillId ||
              (old.price === null || event.price === null
                ? old.price !== event.price
                : Number(old.price) !== event.price)
            )
              continue;
            key = legacy;
            prior = candidate;
            break;
          }
        }
        if (prior) {
          const payload = JSON.parse(prior.payload) as { observedAt?: number };
          if (payload.observedAt !== undefined) return false;
          // Plans and ledger records can refer to the original key outside SQL FKs.
          // A referenced legacy row must keep its key, but it can still be adopted
          // once; otherwise every replay would return false and never deliver.
          const referenced =
            key !== event.key &&
            (prior.plan_id ||
              this.db
                .prepare(
                  "SELECT 1 FROM trade_plans WHERE trigger_key=? LIMIT 1",
                )
                .get(key) ||
              this.db
                .prepare(
                  "SELECT 1 FROM records WHERE id=? OR EXISTS (SELECT 1 FROM json_tree(records.payload) WHERE atom=?) LIMIT 1",
                )
                .get("alerts:outcomes:" + key, key));
          const first = watchEventSchema.parse(
            key === event.key ? payload : { ...payload, price: event.price },
          );
          if (
            first.key !== key ||
            first.type !== event.type ||
            first.strategyId !== event.strategyId ||
            first.version !== event.version ||
            first.market !== event.market ||
            first.symbol !== event.symbol ||
            first.bar !== event.bar ||
            first.sleeve !== event.sleeve
          )
            throw new Error("Conflicting same-bar watch observations");
          // Paper can win this shared key before the minute alert tick. Add the
          // first alert audit once, preserving the original payload and prices.
          const adopted: AlertEvent = {
            ...event,
            ...first,
            key: referenced ? key : event.key,
            planId: event.planId ?? prior.plan_id ?? undefined,
            firstWatchPayload: prior.payload,
            confirmation: { price: event.price, source: event.source },
            source: `本次核对：${event.source}；同bar首条观察未记录来源，原payload保留`,
            reason: `${event.reason}；同bar首条观察价及保护位保留`,
          };
          if (referenced)
            this.db
              .prepare(
                "UPDATE watch_events SET status=?,payload=? WHERE dedupe_key=?",
              )
              .run(adopted.status, JSON.stringify(adopted), key);
          else
            this.db
              .prepare(
                "UPDATE watch_events SET dedupe_key=?,status=?,payload=? WHERE dedupe_key=?",
              )
              .run(event.key, adopted.status, JSON.stringify(adopted), key);
          effects(adopted);
          return true;
        }
        this.db
          .prepare("INSERT INTO watch_events VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(
            event.key,
            event.strategyId,
            event.version,
            event.symbol,
            event.bar,
            event.type,
            event.price,
            event.status,
            event.planId ?? null,
            JSON.stringify(event),
          );
        effects(event);
        return true;
      })
      .immediate();
  }
  private withOutcomes(event: AlertEvent) {
    return {
      ...event,
      outcomes:
        this.state<Outcome[]>(`outcomes:${event.key}`) ?? event.outcomes,
    };
  }
  outcomes(key: string, values: Outcome[]) {
    const previous = this.state<Outcome[]>(`outcomes:${key}`) ?? [];
    this.saveState(
      `outcomes:${key}`,
      values.map(
        (v) => previous.find((p) => p.horizon === v.horizon && p.settled) ?? v,
      ),
    );
  }
  private filter(input: AlertHistoryInput) {
    const terms = ["json_type(payload,'$.observedAt')='integer'"];
    const args: (string | number)[] = [];
    if (input.from) {
      terms.push("substr(bar,1,10)>=?");
      args.push(input.from);
    }
    if (input.to) {
      terms.push("substr(bar,1,10)<=?");
      args.push(input.to);
    }
    for (const [column, value] of [
      ["dedupe_key", input.key],
      ["symbol", input.symbol],
      ["strategy_id", input.strategyId],
      ["type", input.kind],
      ["json_extract(payload,'$.mode')", input.mode],
      ["json_extract(payload,'$.market')", input.market],
    ] as const) {
      if (!value) continue;
      terms.push(`${column}=?`);
      args.push(value);
    }
    return { where: terms.join(" AND "), args };
  }
  history(input: AlertHistoryInput) {
    const { where, args } = this.filter(input);
    return this.db.transaction(() => {
      const total = this.db
        .prepare(`SELECT count(*) AS n FROM watch_events WHERE ${where}`)
        .get(...args) as { n: number };
      const rows = this.db
        .prepare(
          `SELECT payload FROM watch_events WHERE ${where} ORDER BY bar DESC,dedupe_key DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, input.size, input.page * input.size) as {
        payload: string;
      }[];
      return {
        total: total.n,
        items: rows.map((r) =>
          this.withOutcomes(JSON.parse(r.payload) as AlertEvent),
        ),
      };
    })();
  }
  /** Read-only watermark lookup; candidatePage's SQL and ordering stay intact. */
  candidateScans() {
    const prefix = "alerts:candidate-scan:";
    const rows = this.db
      .prepare(
        "SELECT id,payload FROM records WHERE kind='alert-state' AND substr(id,1,?)=? ORDER BY id",
      )
      .all(prefix.length, prefix) as { id: string; payload: string }[];
    return new Map(
      rows.map((row) => [
        row.id.slice(prefix.length),
        JSON.parse(row.payload) as {
          market: "cn-equity" | "crypto";
          strategyId: string;
          version: number;
          period?: Period;
          bar: string | null;
          observedAt: number;
        },
      ]),
    );
  }
  candidatePage(input: {
    page: number;
    strategy?: string;
    market?: "cn-equity" | "crypto";
    minimumRps?: number;
  }) {
    return this.db.transaction(() => {
      const { where, args } = this.filter({
        page: input.page,
        size: 20,
        symbol: "",
        strategyId: input.strategy ?? "",
        kind: "entry",
        market: input.market,
      });
      const rpsStore = new RpsStore(this.db);
      const day = rpsStore.latest();
      const ranking = day?.periods.includes(20)
        ? rpsStore.ranking(day.date, 20)
        : [];
      let clause = `${where} AND status<>'missed'`;
      if (input.minimumRps !== undefined) {
        clause += " AND symbol IN (SELECT value FROM json_each(?))";
        args.push(
          JSON.stringify(
            ranking
              .filter((r) => r.rps >= input.minimumRps!)
              .map((r) => r.symbol),
          ),
        );
      }
      const rankingJson = JSON.stringify(
        Object.fromEntries(ranking.map((r) => [r.symbol, r.rps])),
      );
      const grouped = `WITH current AS (
        SELECT e.* FROM watch_events e JOIN records s
          ON s.kind='alert-state' AND s.id='alerts:candidate-scan:'||json_extract(e.payload,'$.market')||':'||e.strategy_id||':'||e.strategy_version
          AND json_extract(s.payload,'$.bar')=e.bar
      ), rank_values AS (SELECT key symbol,value rps FROM json_each(?)), eligible AS (
        SELECT payload,dedupe_key,symbol,bar,json_extract(payload,'$.market') market,
          (SELECT rps FROM rank_values WHERE rank_values.symbol=current.symbol) rps20,
          CASE WHEN json_type(payload,'$.rankScore') IN ('integer','real')
            THEN json_extract(payload,'$.rankScore')
            ELSE (SELECT rps/100.0 FROM rank_values WHERE rank_values.symbol=current.symbol)
          END priority
        FROM current WHERE ${clause}
      ), grouped AS (
        SELECT market,symbol,max(rps20) rps20,max(priority) priority,json_group_array(json(payload)) sources
        FROM eligible GROUP BY market,symbol
      )`;
      const total = (
        this.db
          .prepare(`${grouped} SELECT count(*) n FROM grouped`)
          .get(rankingJson, ...args) as { n: number }
      ).n;
      const rows = this.db
        .prepare(
          `${grouped} SELECT * FROM grouped ORDER BY priority DESC,market,symbol LIMIT 20 OFFSET ?`,
        )
        .all(rankingJson, ...args, input.page * 20) as {
        sources: string;
        rps20: number | null;
      }[];
      return {
        total,
        items: rows.map((r) => {
          const sources = (JSON.parse(r.sources) as AlertEvent[])
            .sort(
              (a, b) =>
                (b.rankScore ??
                  (r.rps20 === null ? -Infinity : r.rps20 / 100)) -
                  (a.rankScore ??
                    (r.rps20 === null ? -Infinity : r.rps20 / 100)) ||
                a.strategyId.localeCompare(b.strategyId) ||
                b.version - a.version ||
                a.key.localeCompare(b.key),
            )
            .map((e) => this.withOutcomes(e));
          const event = sources[0]!;
          return {
            ...event,
            sources,
            rps20: r.rps20,
            rpsDate: day?.date ?? null,
          };
        }),
      };
    })();
  }
  screenCandidate(jobId: string, snapshotId: string) {
    const row = this.db
      .prepare(
        "SELECT json_extract(payload,'$.input.strategy') strategy FROM records WHERE id=? AND kind='job' AND json_extract(payload,'$.status')='completed' AND json_extract(payload,'$.input.type')='formula-screen' AND EXISTS(SELECT 1 FROM json_each(payload,'$.result.candidates') WHERE json_extract(value,'$.snapshotId')=?)",
      )
      .get(jobId, snapshotId) as { strategy: string } | undefined;
    if (!row) throw new Error("该快照不属于已完成公式任务的候选");
    return row.strategy ? (JSON.parse(row.strategy) as unknown) : null;
  }
  export(input: AlertHistoryInput) {
    const { where, args } = this.filter(input);
    return this.db.transaction(() =>
      (
        this.db
          .prepare(
            `SELECT payload FROM watch_events WHERE ${where} ORDER BY bar DESC,dedupe_key DESC`,
          )
          .all(...args) as { payload: string }[]
      ).map((r) => this.withOutcomes(JSON.parse(r.payload) as AlertEvent)),
    )();
  }
  *pendingOutcomes(maxRows = 100): Generator<AlertEvent> {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000)
      throw new RangeError("提醒结算批次须为 1–1000 的整数");
    type Key = { bar: string; dedupe_key: string };
    const cursor = this.state<{ after: Key; end: Key }>("outcome-scan");
    const end =
      cursor?.end ??
      (this.db
        .prepare(
          "SELECT bar,dedupe_key FROM watch_events ORDER BY bar DESC,dedupe_key DESC LIMIT 1",
        )
        .get() as Key | undefined);
    if (!end) return;
    // Limit physical events examined, including already settled/ineligible
    // rows. A WHERE on eligibility could scan the entire history in one step.
    const select = `SELECT bar,dedupe_key,CASE WHEN
      status<>'missed' AND type<>'missed' AND json_type(payload,'$.observedAt')='integer'
      AND json_extract(payload,'$.type') NOT IN ('regime','allocation')
      AND NOT EXISTS (
        SELECT 1 FROM records WHERE id='alerts:outcomes:'||dedupe_key AND json_array_length(payload)=3
        AND NOT EXISTS(SELECT 1 FROM json_each(payload) WHERE json_extract(value,'$.settled')=0)
      ) THEN payload END AS pending
      FROM watch_events WHERE (bar,dedupe_key)<=(?,?)`;
    const order = " ORDER BY bar,dedupe_key LIMIT ?";
    const rows = (
      cursor
        ? this.db
            .prepare(select + " AND (bar,dedupe_key)>(?,?)" + order)
            .all(
              end.bar,
              end.dedupe_key,
              cursor.after.bar,
              cursor.after.dedupe_key,
              maxRows,
            )
        : this.db.prepare(select + order).all(end.bar, end.dedupe_key, maxRows)
    ) as (Key & { pending: string | null })[];
    for (const row of rows) {
      if (row.pending !== null) yield JSON.parse(row.pending) as AlertEvent;
    }
    // Each tick creates a repository. Checkpoint only after the caller finishes
    // the page, and wrap at the original end to revisit still-pending events.
    const last = rows.at(-1);
    if (
      last &&
      rows.length === maxRows &&
      (last.bar !== end.bar || last.dedupe_key !== end.dedupe_key)
    ) {
      this.saveState("outcome-scan", {
        after: { bar: last.bar, dedupe_key: last.dedupe_key },
        end,
      });
    } else if (cursor) {
      this.saveState("outcome-scan", null);
    }
  }
  plans(openOnly = false) {
    return (
      this.db
        .prepare(
          `SELECT payload FROM trade_plans ${openOnly ? "WHERE status='open'" : ""} ORDER BY created_at DESC,id DESC`,
        )
        .all() as { payload: string }[]
    ).map((r) => tradePlanSchema.parse(JSON.parse(r.payload)));
  }
  savePlan(plan: TradePlan, now: number) {
    this.db
      .prepare("INSERT INTO trade_plans VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        plan.id,
        plan.strategyId,
        plan.strategyVersion,
        plan.symbol,
        plan.sleeve,
        plan.triggerKey,
        plan.expiresAt,
        plan.status,
        JSON.stringify(plan),
        now,
      );
    return plan;
  }
  closePlan(id: string, reason: "triggered" | "cancelled" | "expired") {
    const plan = this.strategies.plan(id);
    if (!plan || plan.status !== "open") return false;
    const next = {
      ...plan,
      status: reason === "expired" ? ("expired" as const) : ("closed" as const),
      closeReason: reason,
    };
    this.db
      .prepare(
        "UPDATE trade_plans SET status=?,payload=? WHERE id=? AND status='open'",
      )
      .run(next.status, JSON.stringify(next), id);
    return true;
  }
}
