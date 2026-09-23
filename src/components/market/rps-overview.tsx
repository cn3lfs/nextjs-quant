"use client";
import { api } from "~/trpc/react";
import { usePanelVisible } from "../workbench/keep-alive";
import { RpsRunStatus } from "./rps-run-status";
import { RpsWorkflowLog } from "./rps-workflow-log";
import { Button } from "../ui/button";

/**
 * Page header panels: the singleton job状态 and the batch历史日志 side by side
 * on the page grid. Both stay above the ranking panel so a running task remains
 * visible whichever population is open.
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
    <>
      <RpsRunStatus progress={status.data?.progress ?? null} />
      <RpsWorkflowLog
        entries={log.data ?? []}
        loading={log.isPending}
        error={log.error?.message}
        onRetry={() => void log.refetch()}
      />
      {status.isError && (
        <p role="alert" className="nc-span-12 m-0 text-[12px] text-nc-bad">
          读取RPS任务状态失败：{status.error.message}
          <Button
            size="sm"
            variant="outline"
            className="ml-2"
            onClick={() => void status.refetch()}
          >
            重试
          </Button>
        </p>
      )}
    </>
  );
}
