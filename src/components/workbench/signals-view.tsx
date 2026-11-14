"use client";
import { MonitorWorkspace } from "../signals/monitor-workspace";
import { api } from "~/trpc/react";
import { useTaskVisible } from "./use-task-visible";
import { Button } from "../ui/button";
export function SignalsView() {
  const visible = useTaskVisible();
  const watchlist = api.status.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    select: (value) => value.watchlist,
  });
  return (
    <>
      {watchlist.error && (
        <p role="alert">
          自选列表未刷新：{watchlist.error.message}{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void watchlist.refetch()}
          >
            重试自选列表
          </Button>
        </p>
      )}
      {watchlist.data ? (
        <MonitorWorkspace watchlist={watchlist.data} />
      ) : (
        !watchlist.error && <p role="status">正在读取自选列表…</p>
      )}
    </>
  );
}
