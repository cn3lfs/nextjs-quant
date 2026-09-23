"use client";
import { api } from "~/trpc/react";
import { usePanelVisible } from "../workbench/keep-alive";
import { RpsRunStatus } from "./rps-run-status";
import { RpsWorkflowLog } from "./rps-workflow-log";
import { Button } from "../ui/button";

/**
 * Page header boxes: the singleton job状态 and the batch历史日志 side by side.
 * Both stay mounted above the per-target tabs so a running task remains visible
 * no matter which tab is open.
 */
export function RpsOverview() {
  const visible = usePanelVisible();
  const status = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 2000,
  });
  const log = api.rpsWorkflowLog.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 10000,
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-2">
        <RpsRunStatus progress={status.data?.progress ?? null} />
        {status.isError && (
          <p role="alert" className="text-sm text-destructive">
            读取RPS任务状态失败：{status.error.message}
            <Button variant="outline" onClick={() => void status.refetch()}>
              重试
            </Button>
          </p>
        )}
      </div>
      <RpsWorkflowLog
        entries={log.data ?? []}
        loading={log.isPending}
        error={log.error?.message}
        onRetry={() => void log.refetch()}
      />
    </div>
  );
}
