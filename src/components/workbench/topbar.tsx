"use client";
import { MagnifyingGlass, Question, Rows } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { alertModeLabel } from "~/lib/common/ui-glossary";
import {
  densityLabels,
  useWorkbenchUiStore,
} from "~/lib/stores/workbench-ui-store";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { navItemFor } from "./navigation";
import { useScreenVisible } from "./use-task-visible";
import { useTaskOverview } from "./use-task-overview";

export function Topbar({
  onOpenCommand,
  onOpenHelp,
}: {
  onOpenCommand: () => void;
  onOpenHelp: () => void;
}) {
  return (
    <header className="topbar">
      <Suspense fallback={<TopbarTitle title="工作台" crumb="观澜" />}>
        <TopbarBreadcrumb />
      </Suspense>
      <div className="top-status">
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 justify-start gap-2 rounded-lg px-3 text-[13px] text-nc-text-4 max-lg:justify-center max-lg:px-0 lg:w-[200px] xl:w-[300px]"
          aria-label="打开命令面板"
          title="搜索页面或输入命令（Ctrl K）"
          onClick={onOpenCommand}
        >
          <MagnifyingGlass size={16} aria-hidden="true" />
          <span className="flex-1 text-left max-lg:hidden">
            搜索页面或输入命令
          </span>
          <kbd className="rounded border border-nc-border px-1 text-[10px] max-xl:hidden">
            Ctrl K
          </kbd>
        </Button>
        <Suspense fallback={null}>
          <StatusChips />
        </Suspense>
        <DensityToggle />
        <Button
          variant="outline"
          size="sm"
          className="h-7 w-7 rounded-full p-0"
          aria-label="快捷键帮助"
          title="快捷键帮助（?）"
          onClick={onOpenHelp}
        >
          <Question size={15} aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}

function TopbarTitle({ crumb, title }: { crumb: string; title: string }) {
  return (
    <div className="topbar-title">
      <nav aria-label="面包屑" className="breadcrumb">
        <span>{crumb}</span>
      </nav>
      <h1 className="truncate">{title}</h1>
    </div>
  );
}

function TopbarBreadcrumb() {
  const pathname = usePathname();
  const search = useSearchParams();
  const item = navItemFor(pathname, search.toString());
  const crumb = item?.group ?? "工作台";
  const page = item?.label ?? "页面";
  const title = item?.title ?? item?.label ?? "工作台";
  return (
    <div className="topbar-title">
      <nav aria-label="面包屑" className="breadcrumb min-w-0 overflow-hidden">
        <span className="truncate">{crumb}</span>
        <span aria-hidden="true">/</span>
        <span className="truncate">{page}</span>
      </nav>
      <h1 className="truncate">{title}</h1>
    </div>
  );
}

function StatusChips() {
  const visible = useScreenVisible();
  const alerts = api.alertStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    retry: false,
  });
  const tasks = useTaskOverview();
  const mode = alerts.error
    ? "读取失败"
    : alerts.data
      ? alertModeLabel(alerts.data.mode)
      : "—";
  const modeTone = alerts.error
    ? "bad"
    : !alerts.data
      ? "idle"
      : alerts.data.mode === "live"
        ? "ok"
        : "warn";
  const lastCheck = alerts.data?.runtime?.lastCheck;
  const alertTitle = `提醒模式：${mode} · ${
    lastCheck
      ? `最近运行 ${new Date(lastCheck).toLocaleString("zh-CN", {
          timeZone: "Asia/Shanghai",
        })}`
      : "尚未运行"
  } · 前往提醒与推送`;
  const running = tasks.data
    ? (tasks.data.running ?? 0) + (tasks.data.queued ?? 0)
    : null;
  const failed = tasks.data?.failed ?? null;
  const taskLabel = tasks.error
    ? "读取失败"
    : !tasks.data
      ? "—"
      : failed
        ? `${failed} 失败`
        : running
          ? `${running} 运行`
          : "空闲";
  const taskTone =
    tasks.error || failed
      ? "bad"
      : running
        ? "warn"
        : tasks.data
          ? "ok"
          : "idle";
  return (
    <>
      <Link
        href="/system/notifications"
        className="nc-status-chip"
        data-state={modeTone}
        title={alertTitle}
      >
        <i aria-hidden="true" />
        <span className="max-xl:hidden">提醒：</span>
        {mode}
      </Link>
      <Link
        href="/system/tasks"
        className="nc-status-chip"
        data-state={taskTone}
        title={`后台任务：${taskLabel} · 前往后台任务`}
      >
        <i aria-hidden="true" />
        <span className="max-xl:hidden">任务：</span>
        {taskLabel}
      </Link>
    </>
  );
}

function DensityToggle() {
  const density = useWorkbenchUiStore((state) => state.density);
  const toggleDensity = useWorkbenchUiStore((state) => state.toggleDensity);
  const next = density === "comfort" ? "紧凑" : "舒适";
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1 rounded-full px-3 text-xs"
      aria-label={`切换为${next}视图`}
      title={`当前${densityLabels[density]}视图，点击切换为${next}`}
      onClick={toggleDensity}
    >
      <Rows size={14} aria-hidden="true" />
      <span className="max-lg:hidden">{densityLabels[density]}</span>
    </Button>
  );
}
