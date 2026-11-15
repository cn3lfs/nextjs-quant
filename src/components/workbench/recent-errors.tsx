"use client";
import Link from "next/link";
import { WarningCircle } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { taskStamp } from "~/lib/research/workflow/task-history";
import { Panel } from "../panels";
import { Button } from "../ui/button";
import { useTaskVisible } from "./use-task-visible";

export function RecentErrors() {
  const visible = useTaskVisible();
  const query = api.recentErrors.useQuery(undefined, {
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
      note="显示最近 30 组后台错误。同一分钟的同类错误合并计数；取消不计为错误。"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          保留脱敏摘要，详细任务状态可从关联入口查看。
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
          错误记录未刷新，请稍后重试。{data ? "下方保留上次读取结果。" : ""}
        </p>
      )}
      {data && !data.available && (
        <p role="alert">错误记录暂不可读，请检查数据目录的空间和权限。</p>
      )}
      {!!data?.unrecordedInThisProcess && (
        <p role="alert">
          本次服务运行有 {data.unrecordedInThisProcess}{" "}
          条错误未能写入日志，记录可能不完整。
        </p>
      )}
      {!data && !query.error && <p>正在读取错误记录…</p>}
      {data?.available && !data.entries.length && <p>暂无已记录的后台错误。</p>}
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
              {entry.jobId && (
                <Link
                  href={`/system/tasks?id=${encodeURIComponent(entry.jobId)}`}
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
    </Panel>
  );
}
