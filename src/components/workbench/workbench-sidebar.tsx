"use client";
import { useEffect } from "react";
import { api } from "~/trpc/react";
import { Sidebar } from "./sidebar";
import { AlertStatus } from "../signals/alert-status";
import { useTaskOverview } from "./use-task-overview";
import { useTaskVisible } from "./use-task-visible";

/** Activity updates belong to navigation, not the page-rendering shell. */
export function WorkbenchSidebar({ active }: { active: string | undefined }) {
  const visible = useTaskVisible();
  const overview = useTaskOverview();
  const utils = api.useUtils();
  const monitorSummary = api.monitorWorkspaceSummary.useQuery(undefined, {
    enabled: visible && active !== "/signals",
    refetchInterval: visible && active !== "/signals" ? 30000 : false,
  });
  const completedScan = overview.data?.latestCompletedScan;
  // A scan may start and finish between polls. Status alone misses consecutive
  // completed scans, so refresh coverage when the completed task/version changes.
  useEffect(() => {
    if (completedScan) void utils.status.invalidate();
  }, [completedScan?.id, completedScan?.updatedAt]);
  const activeCount =
    (overview.data?.running ?? 0) + (overview.data?.queued ?? 0);
  return (
    <Sidebar
      alerts={<AlertStatus compact />}
      active={active}
      badges={{
        "/signals": {
          count: monitorSummary.data?.failedDeliveries ?? 0,
          bad: true,
        },
        "/tasks": { count: activeCount },
      }}
    />
  );
}
