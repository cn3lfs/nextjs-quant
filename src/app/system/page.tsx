"use client";
import { SettingsPanel } from "~/components/workbench/settings-panel";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";

export default function SettingsPage() {
  const notify = useWorkbenchNotify();
  return <SettingsPanel notify={notify} />;
}
