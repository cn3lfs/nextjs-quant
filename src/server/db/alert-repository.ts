import type Database from "better-sqlite3";
import {
  StrategyRepository,
  tradePlanSchema,
  watchEventSchema,
  type TradePlan,
} from "./strategy-repository";
import { NotificationPolicyStore } from "./notification-policy-store";
import { sqlite } from "./index";
import type { StrategyObjectInput } from "trading-strategies";
import type {
  AlertEvent,
  AlertHistoryInput,
  AlertSubscription,
} from "~/lib/strategy-facts/alerts";
import { alertKey } from "~/lib/strategy-facts/alerts";
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
        const prior = this.db
          .prepare(
            "SELECT payload,plan_id FROM watch_events WHERE dedupe_key=?",
          )
          .get(event.key) as
          { payload: string; plan_id: string | null } | undefined;
        if (prior) {
          const payload = JSON.parse(prior.payload) as { observedAt?: number };
          if (payload.observedAt !== undefined) return false;
          const first = watchEventSchema.parse(payload);
          if (
            first.key !== event.key ||
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
            planId: event.planId ?? prior.plan_id ?? undefined,
            firstWatchPayload: prior.payload,
            confirmation: { price: event.price, source: event.source },
            source: `本次核对：${event.source}；同bar首条观察未记录来源，原payload保留`,
            reason: `${event.reason}；同bar首条观察价及保护位保留`,
          };
          this.db
            .prepare(
              "UPDATE watch_events SET status=?,payload=? WHERE dedupe_key=?",
            )
            .run(adopted.status, JSON.stringify(adopted), event.key);
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
  pendingOutcomes(limit = 100) {
    return (
      this.db
        .prepare(
          `SELECT payload FROM watch_events WHERE json_type(payload,'$.observedAt')='integer' AND status<>'missed' AND type<>'missed' AND json_extract(payload,'$.type') NOT IN ('regime','allocation') AND NOT EXISTS (SELECT 1 FROM records WHERE id='alerts:outcomes:'||dedupe_key AND json_array_length(payload)=3 AND NOT EXISTS(SELECT 1 FROM json_each(payload) WHERE json_extract(value,'$.settled')=0)) ORDER BY bar,dedupe_key LIMIT ?`,
        )
        .all(limit) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as AlertEvent);
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
