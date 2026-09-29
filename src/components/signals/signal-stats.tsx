"use client";
import type { RouterOutputs } from "~/trpc/react";
export function SignalStats({
  summary,
}: {
  summary: RouterOutputs["monitorWorkspaceSummary"] | undefined;
}) {
  if (!summary)
    return (
      <p role="status" className="py-3 text-sm">
        正在读取监控统计…
      </p>
    );
  const items = [
    { label: "当前启用订阅", value: summary.enabledMonitors },
    { label: "今日新信号", value: summary.todaySignals },
    { label: "今日平台接受投递", value: summary.todaySent },
    { label: "全部失败投递记录", value: summary.failedDeliveries },
    { label: "暂停证券实例", value: summary.pausedSymbolInstances },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 py-3 lg:grid-cols-5">
      {items.map((item) => (
        <div key={item.label}>
          <p className="text-xs text-nc-text-3">{item.label}</p>
          <p className="text-xl tabular-nums">{item.value}</p>
        </div>
      ))}
    </div>
  );
}
