"use client";
import { Pulse } from "@phosphor-icons/react/ssr";
import type { Delivery, Monitor, Signal } from "~/lib/domain";
import { StatsPanel } from "../panels";

const beijingDate = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 10);

/** Today's counts for 信号与通知, derived from the monitor/signal/delivery lists. */
export function SignalStats({
  monitors,
  signals,
  deliveries,
  now = Date.now(),
}: {
  monitors: readonly Monitor[];
  signals: readonly Signal[];
  deliveries: readonly Delivery[];
  now?: number;
}) {
  const today = beijingDate(now);
  const running = monitors.filter((m) => m.enabled);
  const lastCheck = Math.max(0, ...running.map((m) => m.lastCheck ?? 0));
  const todayDeliveries = deliveries.filter(
    (d) => beijingDate(d.createdAt) === today,
  );
  const sent = todayDeliveries.filter((d) => d.status === "sent").length;
  const failed = deliveries.filter((d) => d.status === "failed");
  const paused = monitors.flatMap((m) =>
    Object.values(m.tradingStatusChecks ?? {}).filter(
      (check) => check.status !== "trading",
    ),
  );
  return (
    <StatsPanel
      icon={Pulse}
      title="今日"
      items={[
        {
          label: "运行中的订阅",
          value: running.length,
          note: lastCheck
            ? `最近检查 ${new Date(lastCheck).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`
            : "等待首次检查",
        },
        {
          label: "新信号",
          value: signals.filter((s) => beijingDate(s.createdAt) === today)
            .length,
          note: "规则触发",
        },
        {
          label: "已送达",
          value: sent,
          note: "平台已接受",
          tone: sent ? "ok" : "neutral",
        },
        {
          label: "投递失败",
          value: failed.length,
          note: failed[0]?.error ?? "可手动重发",
          tone: failed.length ? "bad" : "neutral",
        },
        {
          label: "暂停证券",
          value: paused.length,
          note: "停牌或状态未知",
          tone: paused.length ? "warn" : "neutral",
        },
      ]}
    />
  );
}
