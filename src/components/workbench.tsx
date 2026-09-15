"use client";
import {
  Activity,
  Bell,
  ChevronRight,
  FlaskConical,
  RefreshCw,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type ReactNode } from "react";
import { NewsPanel } from "./news-panel";
import { routePanels } from "./route-panels";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuGroup } from "./ui/menu";

import { Connections } from "./workbench/connections";

import { BacktestView } from "./workbench/backtest-view";
import { EvidenceAnalysis } from "./workbench/evidence-analysis";
import { MarketView } from "./workbench/market-view";
import {
  dailyTabs,
  researchTabs,
  routeTabs,
  tabs,
} from "./workbench/navigation";
import { ResearchArchive } from "./workbench/research-archive";
import { PanelCache } from "./workbench/keep-alive";
import { ScreenView } from "./workbench/screen-view";
import { SignalsView } from "./workbench/signals-view";
import { TaskCenter } from "./workbench/task-center";
import { useWorkbenchState } from "./workbench/use-workbench-state";
export function Workbench({ children }: { children?: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const state = useWorkbenchState();
  const { tab, toast, setToast, status, channels, notify, scan } = state;
  const home = pathname === "/";
  const route = routeTabs.find((item) => item.href === pathname);
  const setTab = (next: typeof tab) => {
    state.setTab(next);
    if (!home) router.push("/", { scroll: false });
  };
  const label = pathname.startsWith("/reports/")
    ? "研究报告详情"
    : (route?.label ?? tabs.find((item) => item.id === tab)?.label);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-symbol">
            <Activity size={25} />
          </div>
          <div>
            <strong>观澜</strong>
            <span>QUANT WORKBENCH</span>
          </div>
        </div>
        <div className="nav-label">我的工作台</div>
        <Menu label="我的工作台">
          {dailyTabs.map((t) => (
            <MenuItem key={t.id} active={home && tab === t.id}>
              <Button
                variant="plain"
                type="button"
                onClick={() => setTab(t.id)}
              >
                <t.icon size={18} />
                {t.label}
              </Button>
            </MenuItem>
          ))}
          {routeTabs.map((item) => (
            <MenuItem key={item.href} active={pathname === item.href}>
              <Link href={item.href} scroll={false}>
                <item.icon size={18} />
                {item.label}
              </Link>
            </MenuItem>
          ))}
          <MenuGroup
            label="更多研究工具"
            icon={<FlaskConical size={18} />}
            active={home && researchTabs.some((t) => t.id === tab)}
          >
            {researchTabs.map((t) => (
              <MenuItem key={t.id} active={home && tab === t.id}>
                <Button
                  variant="plain"
                  type="button"
                  onClick={() => setTab(t.id)}
                >
                  <t.icon size={18} />
                  {t.label}
                </Button>
              </MenuItem>
            ))}
          </MenuGroup>
        </Menu>
        <div className="sidebar-bottom">
          <div className="local-indicator">
            <i /> 本机研究环境
          </div>
          <p>
            数据留在本地
            <br />
            研究连接更广阔的市场
          </p>
          <span>v0.1 · Windows</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            我的工作台 <ChevronRight size={14} />
            {home && researchTabs.some((item) => item.id === tab) && (
              <>
                研究 <ChevronRight size={14} />
              </>
            )}
            <strong>{label}</strong>
          </div>
          <div className="top-status">
            <span className="status-dot" />
            本地服务 <span className="divider" />{" "}
            {status.data?.settings.llmProvider === "deepseek"
              ? status.data.deepseek
                ? "DeepSeek 已配置"
                : "DeepSeek 未配置"
              : status.data?.settings.llmProvider === "claude"
                ? `Claude Code · ${status.data.localModels.claude ? "已安装" : "未安装"}`
                : `Codex · ${status.data?.localModels.codex ? "已安装" : "未安装"}`}
            <Button
              variant="plain"
              className="icon-button"
              aria-label="查看通知"
              onClick={() => setTab("signals")}
            >
              <Bell size={18} />
            </Button>
          </div>
        </header>
        <div className="page">
          {/* Keep the current panel mounted across ledger/RPS navigation. */}
          <div hidden={!home}>
            <div className="page-heading">
              <div>
                <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
                <p>
                  {tab === "market"
                    ? "从真实行情出发，把判断建立在证据上。"
                    : tab === "screen"
                      ? "先用规则缩小范围，再用研究理解差异。"
                      : tab === "backtest"
                        ? "把策略想法变成可以复现的实验。"
                        : tab === "signals"
                          ? "让值得关注的变化，出现在你的聊天窗口。"
                          : tab === "tasks"
                            ? "集中查看运行中的任务、进度与失败原因。"
                            : tab === "reports"
                              ? "保存每一次研究，以及支撑判断的证据。"
                              : "连接本地行情、研究模型与通知渠道。"}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => scan.mutate()}
                disabled={scan.isPending}
              >
                <RefreshCw size={15} />
                扫描本地数据
              </Button>
            </div>
          </div>
          {/* Visited panels stay mounted and hidden: charts, drafts, filters and
              scroll positions survive every tab and route switch. */}
          <PanelCache
            active={home ? tab : pathname}
            panels={{
              market: <MarketView state={state} />,
              screen: <ScreenView state={state} />,
              backtest: <BacktestView state={state} />,
              signals: <SignalsView state={state} />,
              tasks: <TaskCenter state={state} />,
              reports: <ResearchArchive state={state} />,
              analysis: <EvidenceAnalysis state={state} />,
              news: <NewsPanel />,
              settings: status.data && (
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
            }}
          />
          {/* Ledger routes fetch server data per request and keep framework navigation. */}
          {!(pathname in routePanels) && children}
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
