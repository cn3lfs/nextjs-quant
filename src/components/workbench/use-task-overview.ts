"use client";
import { api } from "~/trpc/react";
import { useTaskVisible } from "./use-task-visible";

/** Shared full-scope counts for navigation and the task page. */
export function useTaskOverview() {
  const visible = useTaskVisible();
  return api.taskOverview.useQuery(undefined, {
    enabled: visible,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchInterval: (query) =>
      visible
        ? (query.state.data?.running ?? 0) + (query.state.data?.queued ?? 0) > 0
          ? 2000
          : 30000
        : false,
  });
}
