"use client";
import { SettingsPanel } from "~/components/workbench/settings-panel";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";
import { PaperSettingsPanel } from "~/components/portfolio/paper-settings-panel";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";

export default function SettingsPage() {
  return (
    <Suspense fallback={<p role="status">正在读取系统设置…</p>}>
      <SettingsBody />
    </Suspense>
  );
}
function SettingsBody() {
  const notify = useWorkbenchNotify();
  const search = useSearchParams();
  return (
    <div className="space-y-4">
      <nav className="flex gap-4">
        <Link href="/system">数据与连接</Link>
        <Link href="/system?tab=paper">纸面账户设置</Link>
      </nav>
      {search.get("tab") === "paper" ? (
        <PaperSettingsPanel />
      ) : (
        <SettingsPanel notify={notify} />
      )}
    </div>
  );
}
