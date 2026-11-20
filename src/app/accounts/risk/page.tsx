"use client";
import { Suspense } from "react";
import { SettingsPanel } from "~/components/workbench/settings-panel";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";

export default function RiskSettingsPage() {
  return (
    <Suspense fallback={<p role="status">正在读取仓位与风控设置…</p>}>
      <RiskSettingsBody />
    </Suspense>
  );
}

function RiskSettingsBody() {
  const notify = useWorkbenchNotify();
  return <SettingsPanel scope="risk" notify={notify} />;
}
