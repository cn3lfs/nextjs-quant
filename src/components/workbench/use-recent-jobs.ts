"use client";
import { api } from "~/trpc/react";
import { useTaskVisible } from "./use-task-visible";

/** Recent-result discovery for screening; not a whole-job activity statistic. */
export function useRecentJobs() {
  const visible = useTaskVisible();
  return api.jobs.useQuery(undefined, {
    enabled: visible,
    refetchInterval: (query) =>
      !visible
        ? false
        : query.state.data?.some(
              (job) => job.status === "running" || job.status === "queued",
            )
          ? 2000
          : 30000,
  });
}
