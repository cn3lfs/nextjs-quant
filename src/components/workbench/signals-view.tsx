"use client";
import { MonitorWorkspace } from "../signals/monitor-workspace";
import type { WorkbenchState } from "./use-workbench-state";
export function SignalsView({
  state,
}: {
  state: Pick<WorkbenchState, "watchlist">;
}) {
  return <MonitorWorkspace watchlist={state.watchlist} />;
}
