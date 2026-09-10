import type Database from "better-sqlite3";
import type { Delivery, Signal, Monitor } from "~/lib/domain";
import type { LedgerSignal } from "~/lib/signal-ledger";
import {
  chinaClock,
  grade,
  notificationPolicySchema,
  customQuiet,
  summaryWindow,
  tierLabels,
  withinTradingWindow,
  type NotificationDecision,
  type PolicyUnit,
} from "~/lib/notification-policy";

/** Delivery metadata lives in existing records, never in immutable signal payloads. */
export class NotificationPolicyStore {
  constructor(readonly db: Database.Database) {}
  read<T>(id: string): T | undefined {
    const row = this.db
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as T) : undefined;
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT payload FROM records WHERE kind=? ORDER BY id")
        .all(kind) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as T);
  }
  save<T>(kind: string, id: string, value: T) {
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
      )
      .run(id, kind, JSON.stringify(value), Date.now());
    return value;
  }
  policy() {
    return notificationPolicySchema.parse(
      this.read<{ notificationPolicy?: unknown }>("settings")
        ?.notificationPolicy,
    );
  }
  days() {
    const overrides = this.read<{ calendar?: string[] }>("settings")?.calendar;
    return overrides?.length
      ? overrides
      : (this.read<{ days: string[] }>("notification-calendar")?.days ?? []);
  }
  calendar(days: string[], source: string, now: number) {
    this.save("notification-calendar", "notification-calendar", {
      days,
      source,
      assessedAt: now,
    });
  }
  update(
    d: NotificationDecision,
    tier: NotificationDecision["tier"],
    reason: string,
  ) {
    return this.save("notification-decision", d.id, {
      ...d,
      tier,
      reasons: [...new Set([...d.reasons, reason])],
    });
  }
  decisions() {
    return this.all<NotificationDecision>("notification-decision");
  }
  duplicate(unit: PolicyUnit, channelId: string, now: number) {
    const p = this.policy();
    if (!p.dedupTradingDays) return false;
    const last = this.read<{ date: string }>(this.historyId(unit, channelId));
    return (
      !!last &&
      withinTradingWindow(
        last.date,
        chinaClock(now).date,
        this.days(),
        p.dedupTradingDays,
      )
    );
  }
  private historyId(unit: PolicyUnit, channelId: string) {
    return `notification-history:${channelId}:${unit.symbol}:${unit.strategy}:${unit.direction}`;
  }
  decide(
    unit: PolicyUnit,
    signalId: string,
    channelId: string,
    deliveryId: string,
    body: string,
    now: number,
    messageKind: "signal" | "analysis" = "signal",
  ) {
    const id = `notification-decision:${deliveryId}`;
    const previous = this.read<NotificationDecision>(id);
    if (previous) return previous;
    const policy = this.policy();
    const tier = grade(unit, policy);
    let decision: NotificationDecision = {
      ...unit,
      id,
      signalId,
      channelId,
      deliveryId,
      body,
      messageKind,
      tier,
      reasons: [`质量分档：${tierLabels[tier]}`],
      policy,
      createdAt: now,
    };
    if (
      messageKind === "signal" &&
      tier !== "ledger" &&
      this.duplicate(unit, channelId, now)
    )
      decision = {
        ...decision,
        tier: "ledger",
        reasons: [
          ...decision.reasons,
          `同标的同策略同方向 ${policy.dedupTradingDays} 个交易日内已推送`,
        ],
      };
    // P2 ruling: daily signals arrive after 15:05. Immediate bypasses only
    // outside-trading silence, never custom quiet, budget or dedup enforcement.
    if (decision.tier === "immediate" && customQuiet(now, policy))
      decision = {
        ...decision,
        tier: "summary",
        reasons: [...decision.reasons, "静默时段：转收盘汇总"],
      };
    return this.save("notification-decision", id, decision);
  }
  /** Capture the ledger-only path at insert time, also for unsubscribed observations.
   * Later monitor decisions are joined by exact native point identity at read time. */
  auditLedger(signals: LedgerSignal[]) {
    if (!signals.length) return;
    const policy = this.policy();
    const monitors = this.all<Monitor>("monitor");
    for (const signal of signals) {
      const id = `notification-ledger:${signal.id}`;
      if (this.read(id)) continue;
      const unit = ledgerUnit(signal);
      const eligible = monitors.some(
        (m) =>
          m.enabled &&
          m.period === "day" &&
          m.source !== "mcp" &&
          m.strategy.type === unit.strategy &&
          m.symbols.includes(unit.symbol),
      );
      const tier = grade(unit, policy);
      this.save("notification-ledger", id, {
        ...unit,
        id,
        tier: "ledger",
        reasons: [
          `质量分档：${tierLabels[tier]}`,
          !eligible
            ? "无匹配的已启用本地日线订阅，仅记台账"
            : "未产生对应监控通知（基线/恢复/交易状态/观察级等生成约束）；仅记台账",
        ],
        policy,
        createdAt: Date.now(),
      } satisfies NotificationDecision);
    }
  }
  ledgerDecisions(signal: LedgerSignal, decisions: NotificationDecision[]) {
    const unit = ledgerUnit(signal);
    const matched = decisions.filter(
      (d) =>
        d.symbol === unit.symbol &&
        d.strategy === unit.strategy &&
        d.date === unit.date &&
        d.endpointDate === unit.endpointDate &&
        d.direction === unit.direction &&
        d.score === unit.score &&
        d.pointKey === unit.pointKey &&
        this.read<Signal>(d.signalId ?? "")?.source === "tdx-local",
    );
    return matched.length
      ? matched
      : [
          this.read<NotificationDecision>(
            `notification-ledger:${signal.id}`,
          ) ?? {
            ...unit,
            id: `legacy:${signal.id}`,
            tier: "ledger" as const,
            reasons: ["未记录投递决策（历史记录或审计失败）；仅台账，不补推"],
            policy: notificationPolicySchema.parse({}),
            createdAt: 0,
          },
        ];
  }
  budget(channelId: string, now: number) {
    const id = `notification-budget:${chinaClock(now).date}:${channelId}`;
    return { id, ids: this.read<{ ids: string[] }>(id)?.ids ?? [] };
  }
  /** Called inside outbox's claim transaction, before any I/O. Retries reserve
   * the same logical message slot; ambiguous network outcomes remain deduplicated. */
  claim(delivery: Delivery, now: number): boolean {
    if (!delivery.policyDecisionIds?.length) return true;
    let decisions = delivery.policyDecisionIds
      .map((id) => this.read<NotificationDecision>(id))
      .filter((d): d is NotificationDecision => !!d);
    if (decisions.length !== delivery.policyDecisionIds.length) {
      this.cancel(delivery, "投递决策缺失，停止发送");
      return false;
    }
    const policy = this.policy(),
      days = this.days();
    if (delivery.kind === "analysis") {
      const parents = this.decisions().filter(
        (d) =>
          d.signalId === delivery.signalId &&
          d.channelId === delivery.channelId &&
          d.messageKind !== "analysis",
      );
      if (
        !parents.length ||
        parents.some(
          (d) =>
            d.tier !== "immediate" ||
            !d.deliveryId ||
            ["failed", "expired", "cancelled"].includes(
              this.read<Delivery>(d.deliveryId)?.status ?? "failed",
            ),
        )
      ) {
        for (const d of decisions)
          this.update(d, "ledger", "原信号未成功立即投递；AI解读不追加通知");
        this.cancel(delivery, "原信号未成功立即投递");
        return false;
      }
      if (
        parents.some(
          (d) => this.read<Delivery>(d.deliveryId!)?.status !== "sent",
        )
      )
        return false;
    }
    const isSummary = delivery.kind === "summary";
    if (
      isSummary ? !summaryWindow(now, days, policy) : customQuiet(now, policy)
    ) {
      if (!isSummary && delivery.attempts === 0) {
        for (const d of decisions)
          this.update(
            d,
            delivery.kind === "analysis" ? "ledger" : "summary",
            "投递时处于静默时段",
          );
        this.cancel(delivery, "静默时段：已转汇总或台账");
      }
      return false;
    }
    const budget = this.budget(delivery.channelId, now);
    if (
      !budget.ids.includes(delivery.id) &&
      budget.ids.length >= policy.dailyLimit - (isSummary ? 0 : 1)
    ) {
      for (const d of decisions)
        this.update(
          d,
          isSummary || delivery.kind === "analysis" ? "ledger" : "summary",
          "每日推送上限（含预留1条汇总）",
        );
      this.cancel(delivery, "每日推送上限");
      return false;
    }
    if (delivery.attempts === 0 && delivery.kind !== "analysis") {
      const duplicates = decisions.filter((d) =>
        this.duplicate(d, delivery.channelId, now),
      );
      for (const d of duplicates)
        this.update(
          d,
          "ledger",
          `同标的同策略同方向 ${policy.dedupTradingDays} 个交易日内已推送`,
        );
      if (duplicates.length) {
        decisions = decisions.filter((d) => !duplicates.includes(d));
        if (!isSummary || !decisions.length) {
          this.cancel(delivery, "交易日去重");
          return false;
        }
        // A different pending message may just have claimed one of these units.
        // Retain unrelated digest members instead of cancelling the whole batch.
        delivery.policyDecisionIds = decisions.map((d) => d.id);
        delivery.summarySignalIds = [
          ...new Set(decisions.map((d) => d.signalId!)),
        ];
        delivery.body = renderSummary(chinaClock(now).date, decisions);
      }
    }
    this.save("notification-budget", budget.id, {
      ids: [...new Set([...budget.ids, delivery.id])],
    });
    if (delivery.kind !== "analysis" && delivery.attempts === 0)
      for (const d of decisions)
        this.save(
          "notification-history",
          this.historyId(d, delivery.channelId),
          { date: chinaClock(now).date, deliveryId: delivery.id },
        );
    return true;
  }
  cancel(delivery: Delivery, reason: string) {
    this.save("delivery", delivery.id, {
      ...delivery,
      status: "cancelled",
      error: reason,
    });
  }
}

export function ledgerUnit(signal: LedgerSignal): PolicyUnit {
  let pointKey: string | undefined;
  if (signal.strategy === "czsc") {
    try {
      const evidence = JSON.parse(signal.evidence) as {
        config: number;
        point: { kind: number };
      };
      pointKey = `${evidence.config}:${signal.endpointDate}:${evidence.point.kind}`;
    } catch {
      /* Unknown evidence must never match an unrelated native point. */
    }
  }
  return {
    symbol: signal.symbol,
    strategy: signal.strategy,
    date: signal.observedDate,
    endpointDate: signal.endpointDate,
    direction: signal.direction,
    score: signal.score,
    pointKey,
  };
}

/** One message fits the strictest existing channel limit (WeCom UTF-8 bytes).
 * Keep total/group counts and an explicit ledger pointer when details overflow. */
export function renderSummary(date: string, decisions: NotificationDecision[]) {
  const groups = new Map<string, number>();
  for (const d of decisions) {
    const label = `${d.strategy === "czsc" ? "缠论" : "双突破"} · ${d.direction === "long" ? "向上" : "向下"} · ${d.strategy === "czsc" ? (["观察", "确认", "强质量"][d.score] ?? "未知") : `${d.score}/5`}`;
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const lines = [
    `收盘信号汇总 · ${date}`,
    `待关注 ${decisions.length} 条 · 仅含已启用订阅`,
    ...[...groups].sort().map(([label, n]) => `${label}：${n} 条`),
    "明细（标的 / 质量 / 过滤原因）：",
  ];
  const tail =
    "完整结构证据、失效条件及投递记录见工作台 /signal-ledger。\n来源：各原信号数据源 / 不复权；规则观察，非交易指令。";
  let shown = 0;
  for (const d of decisions) {
    const line = `${d.symbol} · ${d.score}${d.strategy === "dual-breakout" ? "/5" : ""} · ${d.reasons.at(-1)}`;
    if (Buffer.byteLength([...lines, line, tail].join("\n")) > 1550) break;
    lines.push(line);
    shown++;
  }
  if (shown < decisions.length)
    lines.push(`另 ${decisions.length - shown} 条详见台账；本消息不拆分。`);
  return [...lines, tail].join("\n");
}
