"use client";

import { api } from "~/trpc/react";
import { useTaskVisible } from "../workbench/use-task-visible";

/** Consumers share the query cache without making the shell a subscriber. */
export function useSecurityNames() {
  const visible = useTaskVisible();
  return api.securityNames.useQuery(undefined, {
    enabled: visible,
    staleTime: 60000,
    refetchInterval: visible ? 300000 : false,
  });
}
