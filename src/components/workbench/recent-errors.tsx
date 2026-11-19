"use client";
import Link from "next/link";
import type { RefObject } from "react";
import { WarningCircle } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { taskStamp } from "~/lib/research/workflow/task-history";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { useTaskVisible } from "./use-task-visible";

export function RecentErrors({
  jobId,
  onClear,
  focusRef,
}: {
  jobId?: string;
  onClear?: () => void;
  focusRef?: RefObject<HTMLDivElement | null>;
} = {}) {
  const visible = useTaskVisible();
  const scoped = jobId !== undefined;
  const query = api.recentErrors.useQuery(scoped ? { jobId } : undefined, {
    enabled: visible,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: visible ? 30000 : false,
  });
  const data = query.data;
  return (
    <Panel
      icon={WarningCircle}
      title="最近错误"
      note={
        scoped
          ? "按任务编号精确筛选，最多显示最近 30 组。更早的记录可能已滚动清理。"
          : "显示最近 30 组后台错误。同一分钟的同类错误合并计数；取消不计为错误。"
      }
    >
      <div ref={focusRef} tabIndex={-1} className="space-y-3">
        {scoped && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm">
            <span className="min-w-0">
              任务编号：
              <span className="break-all">{jobId}</span>
            </span>
            <Button variant="outline" size="sm" onClick={onClear}>
              查看全部错误
            </Button>
          </div>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {scoped
              ? "保留脱敏摘要。"
              : "保留脱敏摘要，详细任务状态可从关联入口查看。"}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!visible || query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新错误
          </Button>
        </div>
        {query.error && (
          <p role="alert">
            错误记录未刷新，请稍后重试。
            {data ? "下方保留上次读取结果。" : ""}
          </p>
        )}
        {data && !data.available && (
          <p role="alert">错误记录暂不可读，请检查数据目录的空间和权限。</p>
        )}
        {!!data?.unrecordedInThisProcess && (
          <p role="alert">
            本次服务运行有 {data.unrecordedInThisProcess} 条错误未能写入日志
            {scoped ? "（全局计数，不限此任务）" : ""}
            ，记录可能不完整。
          </p>
        )}
        {!data && !query.error && <p>正在读取错误记录…</p>}
        {data?.available &&
          !data.entries.length &&
          (scoped ? (
            <p>此任务暂无保留的错误记录。</p>
          ) : (
            <p>暂无已记录的后台错误。</p>
          ))}
        {!!data?.entries.length && (
          <ul
            aria-label="最近错误记录"
            className="max-h-96 space-y-3 overflow-auto"
          >
            {data.entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-lg border border-border p-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>
                    {entry.module} · {entry.stage}
                  </strong>
                  <span>{entry.count} 次</span>
                </div>
                <p>{entry.summary}</p>
                <p className="break-all text-xs text-muted-foreground">
                  最近 {taskStamp(entry.lastSeen)} · 首次{" "}
                  {taskStamp(entry.firstSeen)} · {entry.code}
                  {entry.retryCount ? ` · 重试 ${entry.retryCount} 次` : ""}
                </p>
                {entry.jobId && !(scoped && entry.jobId === jobId) && (
                  <Link
                    href={`/system/tasks?${new URLSearchParams({ id: entry.jobId, detail: "1" })}`}
                    className="underline underline-offset-2"
                  >
                    查看关联任务
                  </Link>
                )}
                {entry.requestId && (
                  <p className="break-all text-xs text-muted-foreground">
                    请求编号：{entry.requestId}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
