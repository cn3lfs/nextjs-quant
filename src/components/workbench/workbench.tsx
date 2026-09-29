"use client";
import dynamic from "next/dynamic";
import { Activity, X } from "lucide-react";
import { ArrowClockwise } from "@phosphor-icons/react/ssr";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode, type SetStateAction } from "react";
import { TodayOverview } from "../overview/today-overview";
import { routePanels } from "./route-panels";
import { Button } from "../ui/button";

import { navItemFor, tabHref, type Tab } from "./navigation";
import { PanelCache } from "./keep-alive";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { useWorkbenchState } from "./use-workbench-state";
import { OpenChartProvider } from "../market/open-chart";
import type { BrowseList } from "~/lib/market/browse-list";

// Panels load on first visit: the root layout would otherwise ship every
// page body in one client bundle.
const NewsPanel = dynamic(() =>
  import("../news/news-panel").then((m) => m.NewsPanel),
);
const Connections = dynamic(() =>
  import("./connections").then((m) => m.Connections),
);
const BacktestView = dynamic(() =>
  import("./backtest-view").then((m) => m.BacktestView),
);
const EvidenceAnalysis = dynamic(() =>
  import("./evidence-analysis").then((m) => m.EvidenceAnalysis),
);
const MarketView = dynamic(() =>
  import("./market-view").then((m) => m.MarketView),
);
const ResearchArchive = dynamic(() =>
  import("./research-archive").then((m) => m.ResearchArchive),
);
const ScreenView = dynamic(() =>
  import("./screen-view").then((m) => m.ScreenView),
);
const SignalsView = dynamic(() =>
  import("./signals-view").then((m) => m.SignalsView),
);
const TaskCenter = dynamic(() =>
  import("./task-center").then((m) => m.TaskCenter),
);

export function Workbench({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const base = useWorkbenchState();
  const item = navItemFor(pathname);
  // The route is the source of truth; panel state follows it so tab-gated
  // queries keep their original conditions.
  useEffect(() => {
    if (item?.tab && item.tab !== base.tab) base.setTab(item.tab);
  }, [item?.tab]);
  const state = {
    ...base,
    setTab: (next: SetStateAction<Tab>) =>
      router.push(tabHref(typeof next === "function" ? next(base.tab) : next), {
        scroll: false,
      }),
  };
  const { toast, setToast, status, channels, notify, scan } = state;
  // Chart links in tables switch here without reloading the kept-alive panels.
  const openChart = (symbol: string, list?: BrowseList) => {
    base.setBrowse(list ?? null);
    base.setSymbol(symbol);
    base.load.mutate({
      symbol,
      period: base.period,
      source: base.marketSource,
    });
    router.push("/market", { scroll: false });
  };
  const failed = state.monitorSummary.data?.failedDeliveries ?? 0;
  const settings = status.data?.settings;
  const model =
    settings?.llmProvider === "deepseek"
      ? status.data?.deepseek
        ? "DeepSeek 已配置"
        : "DeepSeek 未配置"
      : settings?.llmProvider === "claude"
        ? `Claude Code · ${status.data?.localModels.claude ? "已安装" : "未安装"}`
        : `Codex · ${status.data?.localModels.codex ? "已安装" : "未安装"}`;
  const panels: Record<string, ReactNode> = {
    "/": <TodayOverview state={state} />,
    "/market": <MarketView state={state} />,
    "/screen": <ScreenView state={state} />,
    "/backtest": <BacktestView state={state} />,
    "/signals": <SignalsView state={state} />,
    "/tasks": <TaskCenter state={state} />,
    "/reports": <ResearchArchive state={state} />,
    "/analysis": <EvidenceAnalysis state={state} />,
    "/news": <NewsPanel />,
    "/settings": status.data && (
      <Connections
        value={status.data.settings}
        channels={channels.data ?? []}
        coverage={status.data.coverage}
        notify={notify}
      />
    ),
    ...Object.fromEntries(
      Object.entries(routePanels).map(([href, Panel]) => [
        href,
        <Panel key={href} />,
      ]),
    ),
  };
  return (
    <div className="app-shell">
      <Sidebar
        active={item?.href}
        model={model}
        badges={{
          "/signals": { count: failed, bad: true },
          "/tasks": { count: state.activeJobs.length },
        }}
      />
      <main className="main">
        <Topbar
          crumb={item?.group ?? ""}
          title={item?.title ?? item?.label ?? ""}
          subtitle={item?.subtitle}
        >
          <Button
            variant="plain"
            className="icon-button"
            title="扫描本地数据"
            aria-label="扫描本地数据"
            onClick={() => scan.mutate()}
            disabled={scan.isPending}
          >
            <ArrowClockwise size={16} />
          </Button>
        </Topbar>
        <div className="page">
          {/* Visited panels stay mounted and hidden: charts, drafts, filters and
              scroll positions survive every route switch. */}
          <OpenChartProvider value={openChart}>
            <PanelCache active={pathname} panels={panels} />
            {/* Ledger routes fetch server data per request and keep framework navigation. */}
            {!(pathname in panels) && children}
          </OpenChartProvider>
        </div>
        <footer>
          观澜 · 数据驱动研究，证据支持判断{" "}
          <span>本地数据不会因扫描而被修改</span>
        </footer>
      </main>
      {toast && (
        <div role="status" className="toast">
          <Activity size={17} />
          {toast}
          <Button
            variant="plain"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </Button>
        </div>
      )}
      {status.error && (
        <div className="toast error">连接失败：{status.error.message}</div>
      )}
    </div>
  );
}
