"use client";
import {
  Activity,
  Bell,
  BookOpen,
  ChevronRight,
  FlaskConical,
  RefreshCw,
  X,
} from "lucide-react";
import { NewsPanel } from "./news-panel";
import { Button } from "./ui/button";

import { Connections } from "./workbench/connections";

import { BacktestView } from "./workbench/backtest-view";
import { EvidenceAnalysis } from "./workbench/evidence-analysis";
import { MarketView } from "./workbench/market-view";
import { dailyTabs, researchTabs, tabs } from "./workbench/navigation";
import { ResearchArchive } from "./workbench/research-archive";
import { ScreenView } from "./workbench/screen-view";
import { SignalsView } from "./workbench/signals-view";
import { TaskCenter } from "./workbench/task-center";
import { useWorkbenchState } from "./workbench/use-workbench-state";
export function Workbench() {
  const state = useWorkbenchState();
  const { tab, setTab, toast, setToast, status, channels, notify, scan } =
    state;
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
        <div className="nav-label">研究空间</div>
        <nav>
          {dailyTabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={tab === t.id ? "nav-item active" : "nav-item"}
            >
              <t.icon size={18} />
              {t.label}
              {tab === t.id && <ChevronRight size={14} />}
            </button>
          ))}
          <a className="nav-item" href="/signal-ledger">
            <BookOpen size={18} />
            信号台账
          </a>
          <a className="nav-item" href="/trade-ledger">
            <BookOpen size={18} />
            持仓与交易日志
          </a>
          <details open={researchTabs.some((t) => t.id === tab) || undefined}>
            <summary className="nav-item">
              <FlaskConical size={18} />
              研究
            </summary>
            <nav aria-label="研究">
              {researchTabs.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={tab === t.id ? "nav-item active" : "nav-item"}
                >
                  <t.icon size={18} />
                  {t.label}
                  {tab === t.id && <ChevronRight size={14} />}
                </button>
              ))}
            </nav>
          </details>
        </nav>
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
            <strong>{tabs.find((t) => t.id === tab)?.label}</strong>
          </div>
          <div className="top-status">
            <a href="/signal-ledger">信号台账</a>
            <span className="status-dot" />
            本地服务 <span className="divider" />{" "}
            {status.data?.settings.llmProvider === "deepseek"
              ? status.data.deepseek
                ? "DeepSeek 已配置"
                : "DeepSeek 未配置"
              : status.data?.settings.llmProvider === "claude"
                ? `Claude Code · ${status.data.localModels.claude ? "已安装" : "未安装"}`
                : `Codex · ${status.data?.localModels.codex ? "已安装" : "未安装"}`}
            <button
              className="icon-button"
              aria-label="查看通知"
              onClick={() => setTab("signals")}
            >
              <Bell size={18} />
            </button>
          </div>
        </header>
        <div className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">RESEARCH / {tab.toUpperCase()}</div>
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
          {tab === "market" && <MarketView state={state} />}
          {tab === "screen" && <ScreenView state={state} />}
          {tab === "backtest" && <BacktestView state={state} />}
          {tab === "signals" && <SignalsView state={state} />}
          {tab === "reports" && <ResearchArchive state={state} />}
          {tab === "analysis" && <EvidenceAnalysis state={state} />}
          {tab === "news" && <NewsPanel />}
          {tab === "settings" && status.data && (
            <Connections
              value={status.data.settings}
              channels={channels.data ?? []}
              coverage={status.data.coverage}
              notify={notify}
            />
          )}
          <TaskCenter state={state} />
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
          <button aria-label="关闭提示" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {status.error && (
        <div className="toast error">连接失败：{status.error.message}</div>
      )}
    </div>
  );
}
