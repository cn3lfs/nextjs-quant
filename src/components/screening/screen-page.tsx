"use client";
import { useWorkbenchNotify } from "../workbench/workbench-notify";
import { ScreenWorkspace } from "./screen-workspace";

export function ScreenPage() {
  const notify = useWorkbenchNotify();
  return <ScreenWorkspace notify={notify} />;
}
