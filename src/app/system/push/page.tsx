"use client";
import { Suspense } from "react";
import { SettingsPanel } from "~/components/workbench/settings-panel";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";

export default function PushSettingsPage() {
  return (
    <Suspense fallback={<p role="status">正在读取信号推送设置…</p>}>
      <PushSettingsBody />
    </Suspense>
  );
}

function PushSettingsBody() {
  const notify = useWorkbenchNotify();
  return <SettingsPanel scope="push" notify={notify} />;
}
