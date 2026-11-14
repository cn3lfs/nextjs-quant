"use client";
import { api } from "~/trpc/react";
import { usePanelVisible } from "../workbench/keep-alive";
import { RpsRunStatus } from "./rps-run-status";
import { RpsWorkflowLog } from "./rps-workflow-log";
import { Button } from "../ui/button";
import { rpsPollInterval } from "./rps-status";

/**
 * Keep the active job visible; historical evidence opens when it is needed.
 */
export function RpsOverview() {
  const visible = usePanelVisible();
  const status = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: rpsPollInterval,
  });
  const log = api.rpsWorkflowLog.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 10000,
  });
  return (
    <>
      <RpsRunStatus
        progress={status.data?.progress ?? null}
        readState={status.isError ? "error" : status.data ? "ready" : "loading"}
      />
      <details className="nc-span-6 m-0 rounded-lg border bg-card p-4">
        <summary className="text-sm font-medium">
          历史运行日志{log.error ? " · 读取失败，展开重试" : ""}
        </summary>
        <div className="mt-3">
          <RpsWorkflowLog
            entries={log.data ?? []}
            loading={log.isPending}
            error={log.error?.message}
            onRetry={() => void log.refetch()}
          />
        </div>
      </details>
      {status.isError && (
        <p role="alert" className="nc-span-12 m-0 text-[13px] text-nc-bad">
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
