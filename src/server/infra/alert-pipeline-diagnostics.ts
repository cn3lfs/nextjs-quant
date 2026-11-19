import { createHash } from "node:crypto";
import { AlertRepository } from "../db/alert-repository";
import { readSnapshot } from "../db/snapshot";
import { screenDataHealth } from "../market/data-health";
import { beijingClock } from "~/lib/market/market-session";
import { settings } from "./settings";
import { processAlive } from "./lease";
import type { Channel, Delivery, Settings } from "~/lib/domain";
import { alertHistorySchema } from "~/lib/strategy-facts/alerts";
import type { NotificationDecision } from "~/lib/strategy-facts/notification-policy";

type Readiness = {
  ready: boolean | null;
  expectedDate: string | null;
  closeStatus: string | null;
  scanAt: number | null;
  basis?: string;
};
export function readAlertPipeline(
  repo: AlertRepository,
  mode: Settings["alerts"]["mode"],
  readiness: Readiness,
  now: number,
  eventKey?: string,
) {
  const event = eventKey
    ? repo.event(eventKey)
    : (repo.history(alertHistorySchema.parse({ size: 1 })).items[0] ?? null);
  const runtime = repo.state<{ lastCheck: number; lastPhase?: string }>(
    "runtime",
  );
  const lease = repo.records.read<{ pid: number }>("scheduler-owner");
  const schedulerAlive = lease ? processAlive(lease.pid) : null;
  const subscriptions = repo.subscriptions();
  const enabled = subscriptions.filter((s) => s.enabled);
  const matching = enabled.filter(
    (s) =>
      event &&
      s.market === event.market &&
      s.kinds.includes(event.type) &&
      (!s.symbols.length || s.symbols.includes(event.symbol)) &&
      (!s.strategyIds.length || s.strategyIds.includes(event.strategyId)),
  );
  const signals = event
    ? subscriptions.map(
        (s) =>
          "alert-" +
          createHash("sha256")
            .update(event.key + s.id)
            .digest("hex"),
      )
    : [];
  const channels = repo.records
    .all<Channel>("channel")
    .map(({ id, enabled, configured }) => ({ id, enabled, configured }));
  const channelIds = new Set([
    ...channels.map((c) => c.id),
    ...subscriptions.flatMap((s) => s.channels),
  ]);
  const decisions: Pick<
    NotificationDecision,
    "tier" | "reasons" | "channelId"
  >[] = [];
  const found = new Map<string, Delivery>();
  for (const signal of signals) {
    for (const channel of channelIds) {
      const id =
        "delivery-alert-" +
        createHash("sha256")
          .update(signal + channel)
          .digest("hex");
      const decision = repo.records.read<NotificationDecision>(
        "notification-decision:" + id,
      );
      if (decision)
        decisions.push({
          tier: decision.tier,
          reasons: decision.reasons,
          channelId: channel,
        });
      for (const key of [id, decision?.summaryId]) {
        if (!key || found.has(key)) continue;
        const d = repo.records.read<Delivery>(key);
        if (
          d &&
          (d.alertKey === event?.key || d.summarySignalIds?.includes(signal))
        )
          found.set(key, d);
      }
    }
  }
  const deliveries = [...found.values()]
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    .map(({ id, status, channelId, attempts, nextAt, createdAt, error }) => ({
      // Only publish the sender's fixed HTTP status or a known local category.
      failureReason: error
        ? (error.match(
            /^渠道(?:拒绝请求|服务暂不可用) \(\d{3}(?:\/-?\d+)?\)/,
          )?.[0] ??
          (error === "渠道限流" || error === "凭证不存在"
            ? error
            : "详情见本机投递记录"))
        : null,
      id,
      status,
      channelId,
      attempts,
      nextAt,
      createdAt,
    }));
  const available = channels.filter(
    (c) =>
      c.enabled &&
      c.configured &&
      matching.some((s) => s.channels.includes(c.id)),
  );
  const versionAuthorized = event
    ? (repo.state<{ live: boolean }>(
        `strategy:${event.strategyId}:${event.version}`,
      )?.live ?? false)
    : null;
  const promotedCount = repo
    .definitions()
    .filter((s) => !!repo.state(`promotion:${s.id}:${s.version}`)).length;
  const sent = deliveries.filter((d) => d.status === "sent"),
    failed = deliveries.filter((d) =>
      ["failed", "expired", "cancelled"].includes(d.status),
    );
  const claimed = deliveries.filter((d) => d.attempts > 0);
  const retry = deliveries.filter(
    (d) => d.status === "pending" && d.attempts > 0,
  );
  const queued = deliveries.length > 0;
  const policyReason = decisions.flatMap((d) => d.reasons).at(-1);
  const href = "/system/notifications",
    deliveryHref = href + "?monitorTab=deliveries";
  function stage(
    stage: number,
    label: string,
    passed: boolean,
    summary: string,
    fixHref: string,
    fixLabel: string,
  ) {
    return { stage, label, passed, summary, fixHref, fixLabel };
  }
  const stages = [
    stage(
      1,
      "触发",
      !!event && event.status !== "missed",
      event
        ? event.status === "missed"
          ? "扫描已错过有效窗口"
          : "已记录提醒事件"
        : eventKey
          ? "未找到指定提醒事件"
          : !readiness.ready
            ? "尚无提醒事件，也缺少基准日收盘扫描完成记录"
            : "尚无提醒事件",
      !event && !readiness.ready ? "/system" : "/scan",
      !event && !readiness.ready ? "检查数据与调度" : "查看扫描",
    ),
    stage(
      2,
      "入队",
      queued,
      queued
        ? `已产生 ${deliveries.length} 条投递`
        : (policyReason ?? "尚无该事件的推送队列记录"),
      deliveryHref,
      "查看队列",
    ),
    stage(
      3,
      "订阅",
      matching.length > 0,
      matching.length
        ? `${matching.length} 个启用订阅匹配`
        : enabled.length
          ? "启用订阅未匹配本事件"
          : "没有启用的提醒订阅",
      "/system",
      "设置订阅",
    ),
    stage(
      4,
      "资格",
      mode === "live" &&
        event?.mode === "live" &&
        (event.type !== "entry" || versionAuthorized === true),
      mode !== "live"
        ? `全局模式为 ${mode}，无法出站`
        : event?.mode === "shadow"
          ? "本事件按影子模式记录"
          : event?.type === "entry" && !versionAuthorized
            ? "该策略版本尚未授权 live 提醒"
            : "当前模式允许此类提醒",
      "/lab",
      "核对策略授权",
    ),
    stage(
      5,
      "投递",
      claimed.length > 0 && !retry.length,
      !available.length
        ? "匹配订阅没有已启用且已配置的渠道"
        : retry.length
          ? "渠道投递失败，正在等待重试"
          : claimed.length
            ? `已认领 ${claimed.length} 条投递`
            : "尚未认领出站投递",
      available.length ? deliveryHref : "/system",
      "检查渠道与投递",
    ),
    stage(
      6,
      "回执",
      sent.length > 0 && !failed.length && sent.length === deliveries.length,
      failed.length
        ? `${failed.length} 条投递失败、过期或取消${failed[0]?.failureReason ? "：" + failed[0].failureReason : ""}`
        : sent.length
          ? `${sent.length} 条已成功`
          : "尚无渠道成功回执",
      deliveryHref,
      "查看投递回执",
    ),
  ];
  // Historical receipts win over current configuration. Before a queue exists,
  // show the missing prerequisite rather than the consequent empty queue.
  const blocker = !stages[0]!.passed
    ? stages[0]
    : queued
      ? failed.length
        ? stages[5]
        : retry.length || !claimed.length
          ? stages[4]
          : !stages[5]!.passed
            ? stages[5]
            : null
      : !matching.length
        ? stages[2]
        : !stages[3]!.passed
          ? stages[3]
          : !available.length
            ? stages[4]
            : stages[1];
  return {
    stages,
    primaryBlocker: blocker
      ? {
          stage: blocker.stage,
          reason: blocker.summary,
          fixHref: blocker.fixHref,
          fixLabel: blocker.fixLabel,
        }
      : null,
    evidence: {
      asOf: now,
      readiness,
      lastCheck: runtime?.lastCheck ?? null,
      lastPhase: runtime?.lastPhase ?? null,
      schedulerAlive,
      event: event
        ? {
            key: event.key,
            at: event.observedAt,
            strategyId: event.strategyId,
            version: event.version,
            market: event.market,
            mode: event.mode,
          }
        : null,
      decisions,
      enabledSubscriptions: enabled.length,
      matchedSubscriptions: matching.length,
      mode,
      promotedCount,
      versionAuthorized,
      channels,
      deliveries,
      lastSuccess: sent[0] ?? null,
      lastFailure: failed[0] ?? null,
    },
  };
}
export function alertPipelineDiagnostics(eventKey?: string) {
  return readSnapshot(() => {
    const repo = new AlertRepository(),
      now = Date.now();
    const calendar = repo.records.days();
    const wall = beijingClock(now);
    const calendarConfirmed =
      calendar.includes(wall.date) || wall.weekday === 0 || wall.weekday === 6;
    const expectedDate = screenDataHealth(null, "day", now, {
      days: calendar,
      source: "已记录的交易日历",
      hash: null,
    }).referenceAsOf;
    const close = expectedDate
      ? repo.state<{ status: string; at: number }>(`close:${expectedDate}`)
      : undefined;
    const readiness = {
      expectedDate,
      closeStatus: close?.status ?? null,
      scanAt: close?.at ?? null,
      ready:
        calendarConfirmed &&
        (close?.status === "complete" || close?.status === "running")
          ? true
          : null,
      basis: "基准日收盘调度已核验下载回执；无调度证据时就绪状态未知",
    };
    return readAlertPipeline(
      repo,
      settings().alerts.mode,
      readiness,
      now,
      eventKey,
    );
  });
}
