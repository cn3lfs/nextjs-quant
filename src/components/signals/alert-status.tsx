"use client";
import { api } from "~/trpc/react";
import { alertDisplayCopy } from "~/lib/common/ui-glossary";
import { alertModeLabels } from "~/lib/strategy-facts/alerts";
import { useScreenVisible } from "../workbench/use-task-visible";
export function AlertStatus({ compact = false }: { compact?: boolean }) {
  const visible = useScreenVisible();
  const query = api.alertStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  if (compact) {
    const mode = query.error
      ? "读取失败"
      : query.data
        ? alertModeLabels[query.data.mode]
        : "读取中";
    const last = query.data?.runtime?.lastCheck;
    return (
      <p
        role="status"
        title={`提醒引擎：${mode} · 最近运行 ${last ? new Date(last).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "尚未运行"}`}
        className="m-0 text-center text-[10px] leading-4 text-nc-text-3"
      >
        <span>
          {mode === alertModeLabels.live ? "正式提醒" : `提醒${mode}`}
        </span>
        <br />
        {last
          ? new Date(last).toLocaleTimeString("zh-CN", {
              timeZone: "Asia/Shanghai",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "未运行"}
      </p>
    );
  }
  return (
    <p className="text-xs text-nc-text-3" role="status">
      提醒引擎：
      {query.error
        ? "读取失败"
        : query.data
          ? alertModeLabels[query.data.mode]
          : "读取中"}{" "}
      · 最近运行{" "}
      {query.data?.runtime?.lastCheck
        ? new Date(query.data.runtime.lastCheck).toLocaleString("zh-CN", {
            timeZone: "Asia/Shanghai",
          })
        : "尚未运行"}
      {query.data?.runtime?.error &&
        ` · ${alertDisplayCopy(query.data.runtime.error)}`}
      {!!query.data?.gaps.length &&
        ` · ${query.data.gaps.length}项数据缺口，检查任务中心诊断`}
    </p>
  );
}
