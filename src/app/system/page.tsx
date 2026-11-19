"use client";
import { SettingsPanel } from "~/components/workbench/settings-panel";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";
import { PaperSettingsPanel } from "~/components/portfolio/paper-settings-panel";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { AccountReviewSettingsPanel } from "~/components/portfolio/account-review-settings";
import { DatabaseBackup } from "~/components/common/database-backup";
import { FilterToolbar, MethodologyPopover } from "~/components/panels";

const settingTabs = [
  { key: "data", label: "数据与连接", href: "/system" },
  { key: "paper", label: "本地模拟盘设置", href: "/system?tab=paper" },
  {
    key: "account-risk",
    label: "账户风控设置",
    href: "/system?tab=account-risk",
  },
] as const;

const systemMethodology = [
  {
    label: "配置持久化",
    detail:
      "设置保存在当前数据目录的本地数据库中，重启应用后仍然有效；不同数据目录之间互不影响。",
  },
  {
    label: "本地数据库备份",
    detail:
      "数据与连接页可查看备份位置并立即创建一致性备份；备份包含当前设置与业务数据，请自行妥善保管。",
  },
  {
    label: "通达信目录",
    detail:
      "通达信目录与外部 Blocks 目录按只读方式访问，应用不会改写原始行情文件。",
  },
  {
    label: "凭证存储",
    detail:
      "API Key、Webhook 与令牌经 Windows DPAPI 加密后保存在仓库外，不写入项目文件或日志。",
  },
] as const;

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
  const tab = search.get("tab");
  const activeTab =
    tab === "paper"
      ? "paper"
      : tab === "account-risk"
        ? "account-risk"
        : "data";
  return (
    <div className="space-y-4">
      <FilterToolbar label="系统设置分类">
        {settingTabs.map((item) => {
          const current = item.key === activeTab;
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={`inline-flex items-center whitespace-nowrap rounded-full border px-3 py-1 no-underline transition-colors ${
                current
                  ? "border-nc-accent-700 bg-nc-accent-900 text-nc-accent-light"
                  : "border-nc-border bg-nc-card text-nc-text-3 hover:border-nc-accent-800 hover:text-nc-text-2"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
        <div className="ml-auto shrink-0">
          <MethodologyPopover title="系统设置说明" items={systemMethodology} />
        </div>
      </FilterToolbar>
      {tab === "account-risk" ? (
        <AccountReviewSettingsPanel />
      ) : tab === "paper" ? (
        <PaperSettingsPanel />
      ) : (
        <>
          <DatabaseBackup />
          <SettingsPanel notify={notify} />
        </>
      )}
    </div>
  );
}
