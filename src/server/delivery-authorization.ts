import type { Delivery, Monitor, Signal } from "~/lib/domain";
import { get } from "./db";

export function deliveryCancellationReason(delivery: Delivery): string | null {
  // These are separately initiated user actions, not automatic subscription events.
  if (delivery.kind === "test" || delivery.manualRetry === true) return null;
  if (delivery.kind === "summary") {
    if (!delivery.summarySignalIds?.length) return "汇总缺少原信号授权";
    for (const signalId of delivery.summarySignalIds) {
      const reason = deliveryCancellationReason({
        ...delivery,
        kind: "signal",
        signalId,
      });
      if (reason) return reason;
    }
    return null;
  }
  const signal = get<Signal>(delivery.signalId);
  if (!signal?.monitorRun || typeof signal.monitorId !== "string")
    return "缺少原信号的订阅版本，已取消自动发送";
  const monitor = get<Monitor>(signal.monitorId);
  if (!monitor?.enabled) return "订阅已停用或删除，已取消自动发送";
  if (
    monitor.createdAt !== signal.monitorRun.createdAt ||
    (monitor.revision ?? null) !== signal.monitorRun.revision
  )
    return "订阅已修改或重启，已取消旧版本自动通知";
  if (
    !monitor.channels.includes(delivery.channelId) ||
    !monitor.symbols.includes(signal.symbol)
  )
    return "证券或渠道已移出订阅，已取消自动发送";
  if (delivery.kind === "analysis" && !monitor.ai)
    return "订阅已关闭 AI 解读，已取消自动发送";
  return null;
}
