"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { SettingsPanel } from "~/components/workbench/settings-panel";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";
import { PaperSettingsPanel } from "~/components/portfolio/paper-settings-panel";
import { AccountReviewSettingsPanel } from "~/components/portfolio/account-review-settings";

export default function SettingsPage() {
  return (
    <Suspense fallback={<p role="status">正在读取数据源设置…</p>}>
      <SettingsBody />
    </Suspense>
  );
}

function SettingsBody() {
  const notify = useWorkbenchNotify();
  const search = useSearchParams();
  const tab = search.get("tab");
  if (tab === "account-risk") return <AccountReviewSettingsPanel />;
  if (tab === "paper") return <PaperSettingsPanel />;
  if (tab === "risk") return <SettingsPanel scope="risk" notify={notify} />;
  if (tab === "push") return <SettingsPanel scope="push" notify={notify} />;
  return <SettingsPanel scope="data" notify={notify} />;
}
