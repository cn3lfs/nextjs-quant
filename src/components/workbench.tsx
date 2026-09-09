"use client";
import { OnlineScreen } from "./online-screen";
import { CanslimPanel } from "./canslim-panel";
import { ChanPanel } from "./chan-panel";
import { WyckoffPanel } from "./wyckoff-panel";
import { ValuationPanel } from "./valuation-panel";
import { FinancialQualityPanel } from "./financial-quality-panel";
import { NewsPanel } from "./news-panel";
import { RsSourceDownload } from "./rs-source-download";
import { WalkForwardPanel } from "./walk-forward-panel";
import { BacktestActionsPanel } from "./backtest-actions";
import { DividendLedgerPanel } from "./cash-dividend-experiment";
import { TaskHistory } from "./task-history";
import { ScreenTaskProgress } from "./screen-task-progress";
import { SecurityProfilePanel } from "./security-profile";
import { TradingStatusEvidence } from "./trading-status-evidence";
import { screenSortLabels, type ScreenSort } from "~/lib/screen-sort";
import { securityDisplayName, archivedNameHint } from "~/lib/security-display";
import { useEffect, useState } from "react";
import { defaultBacktestCosts } from "~/lib/backtest-costs";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  Bell,
  BookOpen,
  Check,
  ChevronRight,
  Database,
  FlaskConical,
  LayoutDashboard,
  LoaderCircle,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  TriangleAlert,
  Workflow,
  X,
} from "lucide-react";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { PriceChart } from "./chart";
import { SecuritySelect } from "./security-select";
import {
  defaultStrategy,
  periodSchema,
  type Snapshot,
  type Strategy,
  type Period,
  type Candidate,
  type Backtest,
  type Report,
  type Channel,
  type Settings,
  type Monitor,
} from "~/lib/domain";
type Tab =
  "market" | "screen" | "backtest" | "signals" | "reports" | "settings";
const tabs = [
  { id: "market", label: "行情研究", icon: LayoutDashboard },
  { id: "screen", label: "条件选股", icon: SlidersHorizontal },
  { id: "backtest", label: "策略实验", icon: FlaskConical },
  { id: "signals", label: "信号与通知", icon: Radio },
  { id: "reports", label: "研究档案", icon: BookOpen },
  { id: "settings", label: "数据与连接", icon: Settings2 },
] as const;

const fmt = (n: number | undefined, d = 2) =>
  n === undefined
    ? "—"
    : n.toLocaleString("zh-CN", {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      });
const stamp = (n: number) =>
  new Date(n).toLocaleString("zh-CN", { hour12: false });
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <Database size={25} />
      <p>{children}</p>
    </div>
  );
}
function CalendarEvidence({
  evidence,
}: {
  evidence: Monitor["calendarEvidence"];
}) {
  if (!evidence) return <p className="muted">尚无已归档的日历核验信息</p>;
  return (
    <details>
      <summary>日历核验来源</summary>
      <p>{evidence.source}</p>
      <p>核验时间：{stamp(evidence.assessedAt)}</p>
      <p style={{ overflowWrap: "anywhere" }}>
        来源指纹：{evidence.hash ?? "未记录"}
      </p>
    </details>
  );
}
function ReportArchive({
  names,
  active,
}: {
  names: Record<string, string>;
  active: boolean;
}) {
  const utils = api.useUtils();
  const [cursors, setCursors] = useState<
    ({ createdAt: number; id: string } | undefined)[]
  >([undefined]);
  const [selected, setSelected] = useState("");
  const history = api.reportHistory.useQuery(
    { cursor: cursors.at(-1) },
    {
      staleTime: Infinity,
      refetchInterval: cursors.length === 1 ? (active ? 2000 : 30000) : false,
    },
  );
  const detail = api.archivedReport.useQuery(selected, {
    enabled: !!selected,
    staleTime: Infinity,
  });
  return (
    <section className="panel">
      <h3>通用研究报告</h3>
      <p className="muted">
        选择报告查看完整正文与证据。共 {history.data?.total ?? 0} 份 · 第{" "}
        {cursors.length} 页
      </p>
      <Button
        variant="outline"
        onClick={() => {
          setCursors([undefined]);
          void utils.reportHistory.invalidate();
        }}
      >
        刷新列表
      </Button>
      {history.isLoading && <p role="status">正在读取报告列表…</p>}
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.data?.items.map((item) => (
        <div key={item.id}>
          <button className="text-link" onClick={() => setSelected(item.id)}>
            {item.securityContext
              ? `${securityDisplayName(item.securityContext.symbol, names, item.securityContext.archivedName)} · ${item.securityContext.symbol} · `
              : ""}
            {item.title} · {stamp(item.createdAt)}
          </button>
        </div>
      ))}
      {history.data?.total === 0 && <p>暂无通用研究报告。</p>}
      <Button
        variant="outline"
        disabled={cursors.length === 1 || history.isFetching}
        onClick={() => setCursors(cursors.slice(0, -1))}
      >
        上一页报告
      </Button>
      <Button
        variant="outline"
        disabled={!history.data?.nextCursor || history.isFetching}
        onClick={() => {
          if (history.data?.nextCursor)
            setCursors([...cursors, history.data.nextCursor]);
        }}
      >
        下一页报告
      </Button>
      {selected && detail.isLoading && <p role="status">正在读取完整报告…</p>}
      {detail.error && (
        <p role="alert">
          {detail.error.message}
          <Button onClick={() => void detail.refetch()}>重试报告</Button>
        </p>
      )}
      {selected && detail.isSuccess && !detail.data && <p>该报告不存在。</p>}
      {detail.data && (
        <ReportCard
          report={detail.data}
          securityContext={detail.data.securityContext}
          names={names}
        />
      )}
    </section>
  );
}
function ReportCard({
  report,
  securityContext,
  names,
}: {
  report: Report;
  securityContext: { symbol: string; archivedName?: string } | null;
  names: Record<string, string>;
}) {
  const stageNames = {
    market: "市场与行业",
    fundamentals: "基本面",
    trend: "趋势与相对强度",
    vcp: "VCP形态",
    "entry-risk": "入场与风险",
    conclusion: "综合结论",
  };
  function download() {
    const markdown =
      `# ${report.title}\n\n${report.summary}\n\n` +
      [
        ["支持证据", report.supporting],
        ["反向证据", report.opposing],
        ["风险", report.risks],
        ["缺失数据", report.missing],
        ["下一步", report.nextSteps],
      ]
        .map(
          ([title, items]) =>
            `## ${title}\n\n${(items as string[]).map((t) => "- " + t).join("\n")}\n`,
        )
        .join("\n") +
      (report.stages ?? [])
        .map(
          (s) =>
            `\n## ${stageNames[s.id]}\n\n${s.status}：${s.summary}\n\n缺口：${s.missing.join("；")}\n引用：${s.citations.join("、")}\n`,
        )
        .join("\n") +
      `\n## 版本与证据\n\n模型：${report.model}\n提示词：${report.promptVersion}\n技能：${JSON.stringify(report.skills ?? [])}\n批次用量：${JSON.stringify(report.batchUsage ?? null)}\n时间：${stamp(report.createdAt)}\n\n` +
      report.evidence
        .map(
          (e) =>
            `${e.id} | ${e.source} | ${e.asOf}\n\n证据元数据：${JSON.stringify(e.envelope ?? "旧报告未记录")}\n\n${e.text}\n`,
        )
        .join("\n");
    const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = `研究报告-${report.createdAt}.md`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <article className="report-card">
      <div className="eyebrow">
        <Sparkles size={13} /> AI 研究 · {stamp(report.createdAt)}
        <Button size="sm" variant="ghost" onClick={download}>
          <ArrowDownToLine size={13} />
          导出报告
        </Button>
      </div>
      <p
        className="muted"
        title={
          securityContext
            ? archivedNameHint(
                securityContext.symbol,
                names,
                securityContext.archivedName,
              )
            : undefined
        }
      >
        {securityContext
          ? `关联证券：${securityDisplayName(securityContext.symbol, names, securityContext.archivedName)} · ${securityContext.symbol.toUpperCase()}`
          : "未确认关联证券"}
      </p>
      <h3>{report.title}</h3>
      <p>{report.summary}</p>
      {report.stages?.map((stage) => (
        <section key={stage.id}>
          <h4>
            {stageNames[stage.id]} ·{" "}
            {stage.status === "supported"
              ? "证据支持"
              : stage.status === "contradicted"
                ? "存在反证"
                : "证据不足"}
          </h4>
          <p>{stage.summary}</p>
          {stage.missing.length > 0 && <p>缺口：{stage.missing.join("；")}</p>}
          <small>引用：{stage.citations.join("、")}</small>
        </section>
      ))}
      <div className="report-grid">
        {[
          ["支持证据", report.supporting],
          ["反向证据", report.opposing],
          ["主要风险", report.risks],
          ["待补充数据", report.missing],
          ["下一步观察", report.nextSteps],
        ].map(([title, items]) => (
          <div key={title as string}>
            <h4>{title as string}</h4>
            <ul>
              {(items as string[]).map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <details>
        <summary>查看证据与版本</summary>
        <p className="muted">
          {report.model} · {report.promptVersion} ·{" "}
          {report.batchUsage
            ? `本批 ${report.batchUsage.tokens} tokens / ${report.batchUsage.reports} 份报告`
            : `${report.tokens} tokens`}
        </p>
        {report.skills?.map((skill) => (
          <div key={skill.skillId}>
            <strong>
              {skill.skillId} · {skill.ruleVersion} · {skill.outputSchema}
            </strong>
            <p>前提：{skill.prerequisites.join("；")}</p>
            <pre>
              {skill.files
                .map((file) => `${file.file}: ${file.hash}`)
                .join("\n")}
            </pre>
          </div>
        ))}
        {report.evidence.map((e) => (
          <div key={e.id}>
            <strong>
              {e.id} · {e.source} · {e.asOf}
            </strong>
            <pre>{e.text}</pre>
            {[
              "hithink-astock-selector/rs",
              "hithink-astock-selector/price-rs",
            ].includes(e.envelope?.source ?? "") && (
              <RsSourceDownload reportId={report.id} evidence={e} />
            )}
            {e.envelope && (
              <div>
                <p>
                  数据时点：{e.envelope.asOf ?? "未核验"} · 抓取时间：
                  {stamp(e.envelope.fetchedAt)}
                </p>
                <p>{e.envelope.warnings.join("；")}</p>
                <details>
                  <summary>来源与口径</summary>
                  <pre>{JSON.stringify(e.envelope, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        ))}
      </details>
    </article>
  );
}
function StrategyFields({
  strategy,
  setStrategy,
}: {
  strategy: Strategy;
  setStrategy: (value: Strategy) => void;
}) {
  return (
    <div className="form-grid">
      <Field label="短均线">
        <input
          type="number"
          value={strategy.fast}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              fast: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="长均线">
        <input
          type="number"
          value={strategy.slow}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              slow: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="最低涨幅 %">
        <input
          type="number"
          value={strategy.minChange}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              minChange: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="最高涨幅 %">
        <input
          type="number"
          value={strategy.maxChange}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              maxChange: Number(e.target.value),
            })
          }
        />
      </Field>
      <Field label="最低量比">
        <input
          type="number"
          step="0.1"
          value={strategy.minVolumeRatio}
          onChange={(e) =>
            setStrategy({
              ...strategy,
              type: undefined,
              minVolumeRatio: Number(e.target.value),
            })
          }
        />
      </Field>
    </div>
  );
}
export function Workbench() {
  const [tab, setTab] = useState<Tab>("market"),
    [symbol, setSymbol] = useState("sh600519"),
    [period, setPeriod] = useState<Period>("day"),
    [loaded, setLoaded] = useState<Snapshot | null>(null),
    [strategy, setStrategy] = useState<Strategy>(defaultStrategy),
    [toast, setToast] = useState(""),
    [onlineQuery, setOnlineQuery] = useState(""),
    [prompt, setPrompt] = useState("寻找处于上升趋势、成交量放大的股票"),
    [question, setQuestion] = useState(
      "分析当前趋势、反向证据和需要注意的风险",
    ),
    [universe, setUniverse] = useState(""),
    [researchMethod, setResearchMethod] = useState<"general" | "sepa">(
      "general",
    ),
    [historicalDate, setHistoricalDate] = useState(""),
    [universeSource, setUniverseSource] = useState(""),
    [requireCurrent, setRequireCurrent] = useState(false),
    [initial, setInitial] = useState(100000),
    [backtestScope, setBacktestScope] = useState<"full" | "window">("full"),
    [backtestCosts, setBacktestCosts] = useState(defaultBacktestCosts),
    [screenId, setScreenId] = useState(""),
    [screenPage, setScreenPage] = useState(0),
    [excludedPage, setExcludedPage] = useState(0),
    [errorPage, setErrorPage] = useState(0),
    [screenQuery, setScreenQuery] = useState(""),
    [screenReportId, setScreenReportId] = useState(""),
    [screenSort, setScreenSort] = useState<ScreenSort>("original"),
    [screenDirection, setScreenDirection] = useState<"asc" | "desc">("desc"),
    [backtestId, setBacktestId] = useState(""),
    [draftId, setDraftId] = useState("");
  const directory = api.securityNames.useQuery(undefined, {
    staleTime: 60000,
    refetchInterval: 300000,
  });
  const names = directory.data ?? {};
  const utils = api.useUtils(),
    status = api.status.useQuery(undefined, { refetchInterval: 30000 }),
    jobs = api.jobs.useQuery(undefined, {
      refetchInterval: (query) =>
        query.state.data?.some(
          (j) => j.status === "running" || j.status === "queued",
        )
          ? 2000
          : 30000,
    }),
    channels = api.channels.useQuery(),
    monitors = api.monitors.useQuery(undefined, { refetchInterval: 10000 }),
    signals = api.signals.useQuery(undefined, { refetchInterval: 10000 }),
    deliveries = api.deliveries.useQuery(undefined, { refetchInterval: 4000 });
  const notify = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 7000);
  };
  const onError = (e: { message: string }) => notify(e.message);
  const identityRecord = api.identityRecord.useQuery(symbol, {
    staleTime: 60000,
  });
  const verifyIdentity = api.securityIdentity.useMutation({
    onSuccess: () => {
      void utils.securityNames.invalidate();
      void utils.securities.invalidate();
      void utils.identityRecord.invalidate();
      void utils.securityProfile.invalidate();
    },
    onError,
  });
  const identity =
    verifyIdentity.data?.symbol === symbol
      ? verifyIdentity.data
      : identityRecord.data;
  const load = api.snapshot.useMutation({
    onSuccess: (s) => {
      setLoaded(s);
      setSymbol(s.symbol);
    },
    onError,
  });
  const scan = api.scan.useMutation({
    onSuccess: () => {
      notify("开始扫描本地行情，进度显示在任务栏");
      void utils.jobs.invalidate();
    },
    onError,
  });
  const screen = api.screen.useMutation({
    onSuccess: (j) => {
      const { input: _input, result: _result, ...summary } = j;
      utils.jobSummary.setData(
        { id: j.id, screenFirstPage: true },
        { ...summary, screenFirstPage: null },
      );
      setScreenId(j.id);
      setExcludedPage(0);
      setErrorPage(0);
      setScreenPage(0);
      setScreenQuery("");
      notify("选股任务已开始");
      void utils.jobs.invalidate();
    },
    onError,
  });
  const runBacktest = api.backtest.useMutation({
    onSuccess: (j) => {
      setBacktestId(j.id);
      notify("研究模拟已开始");
      void utils.jobs.invalidate();
    },
    onError,
  });
  const interpret = api.interpret.useMutation({
    onSuccess: (j) => {
      setDraftId(j.id);
      notify("正在解析条件；生成后请确认再运行");
    },
    onError,
  });
  const analyze = api.analyze.useMutation({
    onSuccess: () => notify("研究任务已加入队列，可在研究档案查看"),
    onError,
  });
  const watch = api.watchlist.useMutation({
    onSuccess: () => void utils.status.invalidate(),
    onError,
  });
  const cancel = api.cancel.useMutation({
    onSuccess: () => void utils.jobs.invalidate(),
    onError,
  });
  const saveMonitor = api.saveMonitor.useMutation({
    onSuccess: () => {
      notify("监控已启用，从当前行情建立基线");
      void utils.monitors.invalidate();
    },
    onError,
  });
  const toggleMonitor = api.toggleMonitor.useMutation({
    onSuccess: () => void utils.monitors.invalidate(),
    onError,
  });
  const retry = api.retryDelivery.useMutation({
    onSuccess: () => {
      notify("已加入手动重发队列");
      void utils.deliveries.invalidate();
    },
    onError,
  });
  const [monitorType, setMonitorType] = useState<
    "ma-cross" | "czsc" | "dual-breakout"
  >("ma-cross");
  const [monitorName, setMonitorName] = useState("趋势跟踪"),
    [monitorChannels, setMonitorChannels] = useState<string[]>([]),
    [monitorAi, setMonitorAi] = useState(true),
    [monitorSource, setMonitorSource] = useState<"local" | "mcp">("mcp");
  useEffect(() => {
    load.mutate({ symbol: "sh600519", period: "day" });
  }, []);
  useEffect(() => {
    if (jobs.data?.some((j) => j.type === "scan" && j.status === "completed"))
      void utils.status.invalidate();
  }, [jobs.data?.find((j) => j.type === "scan")?.status]);
  const activeJobs =
    jobs.data?.filter((j) => ["running", "queued"].includes(j.status)) ?? [];
  const selectedScreen = api.jobSummary.useQuery(
    { id: screenId, screenFirstPage: true },
    {
      enabled: !!screenId && tab === "screen",
      refetchInterval: (query) => {
        const job = query.state.data;
        if (!job || !["queued", "running"].includes(job.status)) return false;
        // Keep short cached runs responsive without polling long scans at 10 Hz.
        const age = Date.now() - job.createdAt;
        return age >= 0 && age < 5000 ? 100 : 250;
      },
    },
  );
  const screenJob =
    selectedScreen.data ??
    jobs.data?.find((j) => j.id === screenId) ??
    jobs.data?.find((j) => j.type === "screen");
  const firstScreenPage =
    screenPage === 0 &&
    excludedPage === 0 &&
    errorPage === 0 &&
    screenQuery === "" &&
    screenSort === "original"
      ? selectedScreen.data?.screenFirstPage
      : null;
  const screened = api.screenResults.useQuery(
    {
      id: screenJob?.id ?? "",
      version: screenJob?.updatedAt,
      page: screenPage,
      excludedPage,
      errorPage,
      query: screenQuery,
      sort: screenSort,
      direction: screenDirection,
    },
    {
      enabled:
        !!screenJob?.id && screenJob.status === "completed" && !firstScreenPage,
      placeholderData: (previous) =>
        previous?.jobId === screenJob?.id ? previous : undefined,
    },
  );
  const [exportingScreen, setExportingScreen] = useState(false);
  async function exportScreen() {
    if (!screenJob?.id) return;
    setExportingScreen(true);
    try {
      const data = await utils.screenExport.fetch(screenJob.id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `本地选股-${data.asOf?.replaceAll(":", "-") ?? "未记录基准日"}-${data.jobId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败");
    } finally {
      setExportingScreen(false);
    }
  }
  const screenResult = firstScreenPage ?? screened.data;
  const reviews = api.screenReviews.useQuery(
    {
      id: screenJob?.id ?? "",
      snapshotIds: screenResult?.candidates.map((c) => c.snapshotId) ?? [],
    },
    {
      enabled: tab === "screen" && !!screenJob?.id && !!screenResult,
      refetchInterval: (q) =>
        ["queued", "running"].includes(q.state.data?.research?.status ?? "")
          ? 2000
          : false,
    },
  );
  const screenReport = api.archivedReport.useQuery(screenReportId, {
    enabled: tab === "screen" && !!screenReportId,
    staleTime: Infinity,
  });
  const btJob =
    jobs.data?.find((j) => j.id === backtestId) ??
    jobs.data?.find((j) => j.type === "backtest");
  const btDetails = api.job.useQuery(
    { id: btJob?.id ?? "", version: btJob?.updatedAt },
    { enabled: !!btJob?.id && btJob.status === "completed" },
  );
  const bt = btDetails.data?.result as Backtest | undefined;
  const draftJob = jobs.data?.find((j) => j.id === draftId);
  const draftDetails = api.job.useQuery(
    { id: draftId, version: draftJob?.updatedAt },
    { enabled: !!draftId && draftJob?.status === "completed" },
  );
  const draft = draftDetails.data?.result as
    | { strategy: Strategy; explanation: string; unsupported: string[] }
    | undefined;
  const last = loaded?.bars.at(-1),
    previous = loaded?.bars.at(-2),
    change =
      last && previous ? (last.close / previous.close - 1) * 100 : undefined;
  const watchlist = status.data?.watchlist ?? [];
  const symbols = () =>
    universe.trim() ? universe.split(/[\s,，]+/).filter(Boolean) : undefined;

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
          {tabs.map((t) => (
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
          {tab === "market" && (
            <>
              <div className="market-layout">
                <section className="panel chart-panel">
                  <div className="panel-toolbar">
                    <SecuritySelect
                      symbol={symbol}
                      name={
                        loaded?.symbol === symbol
                          ? securityDisplayName(symbol, names, loaded.name)
                          : names[symbol]
                      }
                      period={period}
                      disabled={load.isPending}
                      onSelect={(next) => {
                        setSymbol(next);
                        load.mutate({
                          symbol: next,
                          period,
                          source:
                            loaded?.source === "tdx-mcp" ? "mcp" : "local",
                        });
                      }}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        load.mutate({ symbol, period, source: "mcp" })
                      }
                      disabled={load.isPending}
                    >
                      MCP 最新行情
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={verifyIdentity.isPending}
                      onClick={() => verifyIdentity.mutate(symbol)}
                    >
                      {verifyIdentity.isPending ? "核验中…" : "核验证券身份"}
                    </Button>
                    <div className="segmented">
                      {periodSchema.options.map((p) => (
                        <button
                          className={period === p ? "selected" : ""}
                          key={p}
                          disabled={load.isPending}
                          onClick={() => {
                            setPeriod(p);
                            load.mutate({ symbol, period: p });
                          }}
                        >
                          {p === "day" ? "日 K" : "5 分钟"}
                        </button>
                      ))}
                    </div>
                  </div>
                  <SecurityProfilePanel key={symbol} symbol={symbol} />
                  {identity && (
                    <details className="notice">
                      <summary>
                        身份核验：
                        {
                          {
                            confirmed: "双源一致",
                            partial: "单源确认",
                            conflict: "来源冲突",
                            unavailable: "未确认",
                          }[identity.status]
                        }{" "}
                        · {identity.name ?? identity.symbol}
                      </summary>
                      <p>
                        {identity.reason} · {stamp(identity.checkedAt)}
                      </p>
                      <p>
                        身份核验不代表当前正常交易；停复牌与行情时效需另外检查。
                      </p>
                      <pre>
                        {JSON.stringify(
                          { tencent: identity.tencent, tdx: identity.tdx },
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  )}
                  <div className="quote-heading">
                    <div>
                      <div className="eyebrow">
                        {loaded?.symbol.toUpperCase() ?? "本地行情"}{" "}
                        <span className="tag">不复权</span>
                        {loaded?.historicalAsOf && (
                          <span className="tag">
                            历史快照 · 截至 {loaded.historicalAsOf}
                          </span>
                        )}
                      </div>
                      <h2
                        title={
                          loaded
                            ? archivedNameHint(
                                loaded.symbol,
                                names,
                                loaded.name,
                              )
                            : undefined
                        }
                      >
                        {loaded
                          ? securityDisplayName(
                              loaded.symbol,
                              names,
                              loaded.name,
                            )
                          : "加载行情"}
                      </h2>
                    </div>
                    <div className="quote-price">
                      <strong>{fmt(last?.close)}</strong>
                      <span className={(change ?? 0) >= 0 ? "up" : "down"}>
                        {(change ?? 0) >= 0 ? "+" : ""}
                        {fmt(change)}%
                      </span>
                    </div>
                  </div>
                  <div className="quote-strip">
                    <span>
                      开盘 <b>{fmt(last?.open)}</b>
                    </span>
                    <span>
                      最高 <b>{fmt(last?.high)}</b>
                    </span>
                    <span>
                      最低 <b>{fmt(last?.low)}</b>
                    </span>
                    <span>
                      成交额{" "}
                      <b>{last ? fmt(last.amount / 1e8) + " 亿" : "—"}</b>
                    </span>
                  </div>
                  {loaded && !load.isPending ? (
                    <PriceChart
                      key={loaded.id}
                      bars={loaded.bars}
                      snapshotId={loaded.id}
                      period={loaded.period}
                    />
                  ) : (
                    <Empty>
                      {load.isPending
                        ? "正在读取本地文件…"
                        : "输入 sh600519 等证券代码加载本地行情"}
                    </Empty>
                  )}
                  <div className="source-line">
                    <Database size={13} />
                    {loaded?.source === "tdx-mcp"
                      ? "通达信 MCP"
                      : "通达信本地"}{" "}
                    · {last?.date ?? "—"} · {loaded?.bars.length ?? 0} 条记录
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => watch.mutate([...watchlist, symbol])}
                    >
                      <Plus size={13} />
                      加入自选
                    </Button>
                  </div>
                </section>
                <aside className="panel research-panel">
                  <div className="panel-title">
                    <Sparkles size={18} />
                    <h3>证据分析</h3>
                    <span className="tag ai">
                      {status.data?.settings.llmProvider === "deepseek"
                        ? "DeepSeek"
                        : status.data?.settings.llmProvider === "claude"
                          ? "Claude Code"
                          : "Codex"}
                    </span>
                  </div>
                  <div className="research-intro">
                    <div className="orbit">
                      <Sparkles size={28} />
                    </div>
                    <h3>多看一层，少猜一步</h3>
                    <p>
                      基于当前行情与计算指标，分析趋势、反向证据和潜在风险。
                    </p>
                  </div>
                  <Field label="研究问题">
                    <textarea
                      rows={4}
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                    />
                  </Field>
                  <Field label="研究方法">
                    <select
                      value={researchMethod}
                      onChange={(e) =>
                        setResearchMethod(e.target.value as "general" | "sepa")
                      }
                    >
                      <option value="general">通用证据分析</option>
                      <option value="sepa">SEPA 分阶段研究</option>
                    </select>
                  </Field>
                  <Button
                    className="full"
                    disabled={!loaded || analyze.isPending}
                    onClick={() =>
                      loaded &&
                      analyze.mutate({
                        snapshotId: loaded.id,
                        question,
                        method: researchMethod,
                        strategy,
                      })
                    }
                  >
                    <Sparkles size={15} />
                    开始研究
                  </Button>
                  <div className="evidence-note">
                    <Check size={14} />
                    数据来源与时间可追溯
                    <br />
                    <Check size={14} />
                    缺少证据时明确标注
                  </div>
                  <button
                    className="text-link"
                    onClick={() => setTab("reports")}
                  >
                    查看研究档案 <ArrowUpRight size={14} />
                  </button>
                  <CanslimPanel snapshot={loaded ?? undefined} />
                  <ChanPanel snapshot={loaded ?? undefined} />
                  <WyckoffPanel snapshot={loaded ?? undefined} />
                </aside>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <h3>我的自选</h3>
                  <span className="muted">{watchlist.length} 个标的</span>
                </div>
                <div className="watchlist">
                  {watchlist.map((s) => (
                    <div className="watch-item" key={s}>
                      <button
                        onClick={() => {
                          setSymbol(s);
                          load.mutate({ symbol: s, period });
                        }}
                      >
                        <span className="stock-avatar">
                          {s.slice(0, 2).toUpperCase()}
                        </span>
                        <span>
                          <strong>{securityDisplayName(s, names)}</strong>
                          <small>{s.toUpperCase()}</small>
                        </span>
                        <ArrowUpRight size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`移除 ${s}`}
                        onClick={() =>
                          watch.mutate(watchlist.filter((v) => v !== s))
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
          {tab === "screen" && (
            <>
              <OnlineScreen
                jobs={jobs.data ?? []}
                query={onlineQuery}
                setQuery={setOnlineQuery}
                onImport={(selected) => {
                  setUniverse(selected.join(","));
                  notify(
                    `已将本页 ${selected.length} 只证券填入本地池，请核对周期与规则后运行复核`,
                  );
                }}
              />
              <section className="panel">
                <div className="panel-title">
                  <Sparkles size={17} />
                  <h3>本地条件草案（双均线）</h3>
                </div>
                <div className="inline-form">
                  <input
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    aria-label="自然语言选股条件"
                  />
                  <Button
                    onClick={() => interpret.mutate(prompt)}
                    disabled={interpret.isPending}
                  >
                    <Sparkles size={15} />
                    生成条件草案
                  </Button>
                </div>
                {draft && (
                  <div className="notice">
                    <p>{draft.explanation}</p>
                    {draft.unsupported.length > 0 && (
                      <div>
                        <p>本地不支持：{draft.unsupported.join("、")}</p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setOnlineQuery(prompt);
                            document
                              .getElementById("online-screener")
                              ?.scrollIntoView({ behavior: "smooth" });
                          }}
                        >
                          将原需求填入在线筛选
                        </Button>
                      </div>
                    )}
                    <Button
                      size="sm"
                      disabled={draft.unsupported.length > 0}
                      onClick={() => {
                        setStrategy(draft.strategy);
                        notify("草案已应用，请核对后运行");
                      }}
                    >
                      确认并应用草案
                    </Button>
                  </div>
                )}
              </section>
              <section className="panel">
                <div className="panel-title">
                  <SlidersHorizontal size={17} />
                  <h3>本地可复现条件</h3>
                  <span className="tag">双均线趋势</span>
                </div>
                <StrategyFields strategy={strategy} setStrategy={setStrategy} />
                <label className="muted">
                  <input
                    type="checkbox"
                    checked={requireCurrent}
                    disabled={!!historicalDate}
                    onChange={(e) => setRequireCurrent(e.target.checked)}
                  />
                  严格当前模式：时点落后或无法核验时停止，不生成候选分析
                </label>
                <div className="form-grid">
                  <Field label="历史研究截止日（留空使用本地最近时点）">
                    <input
                      type="date"
                      value={historicalDate}
                      onChange={(e) => {
                        setHistoricalDate(e.target.value);
                        if (e.target.value) setRequireCurrent(false);
                      }}
                    />
                  </Field>
                  {historicalDate && (
                    <Field label="历史证券池来源">
                      <input
                        value={universeSource}
                        onChange={(e) => setUniverseSource(e.target.value)}
                        placeholder="例如：某日期指数成分股存档；含退市证券的自建名单"
                      />
                    </Field>
                  )}
                </div>
                {historicalDate && (
                  <p className="muted">
                    历史研究必须填写证券池及来源。按截止日过滤完整历史后计算；分钟历史首次读取可能较慢，可在任务中心取消。当前简称不能证明当时身份，复权及历史事件仍需核验。
                  </p>
                )}
                <div className="inline-form">
                  <Field label="证券池（留空扫描全部本地 A 股；代码以逗号分隔）">
                    <input
                      value={universe}
                      onChange={(e) => setUniverse(e.target.value)}
                      placeholder="sh600519,sz000001,sz300750"
                    />
                  </Field>
                  <Button
                    onClick={() =>
                      screen.mutate({
                        strategy,
                        period,
                        symbols: symbols(),
                        asOf: historicalDate || undefined,
                        requireCurrent,
                        universeSource: historicalDate
                          ? universeSource
                          : undefined,
                      })
                    }
                    disabled={screen.isPending}
                  >
                    <Play size={15} />
                    运行选股
                  </Button>
                </div>
                <p className="muted">
                  收盘价高于短均线，短均线高于长均线，并满足涨幅与量比条件。采用{" "}
                  {period === "day" ? "日线" : "五分钟线"}，按均线差排序。
                </p>
              </section>
              <section className="panel">
                <div className="panel-title">
                  <h3>候选结果</h3>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      exportingScreen || screenJob?.status !== "completed"
                    }
                    onClick={exportScreen}
                  >
                    {exportingScreen ? "导出中…" : "导出本次完整结果"}
                  </Button>
                  <span className="tag">
                    {screenResult?.candidateTotal ?? "—"} 个
                  </span>
                  <span className="muted">
                    {screenResult
                      ? `已检查 ${screenResult.total} 个 · ${screenResult.errorTotal} 个读取异常 · ${screenResult.excludedTotal} 个已隔离`
                      : screenJob?.status === "completed"
                        ? "任务已完成，候选结果尚未读取"
                        : "运行后显示真实结果"}
                  </span>
                </div>
                {screenJob?.id && <ScreenTaskProgress id={screenJob.id} />}
                {!firstScreenPage && screened.isError && (
                  <div role="alert" className="notice">
                    <p>
                      候选结果读取失败：{screened.error.message}
                      。原选股任务和数据已保留，无需重新选股。
                    </p>
                    <Button
                      disabled={screened.isFetching}
                      onClick={() => void screened.refetch()}
                    >
                      重试读取候选
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setScreenSort("original");
                        setScreenQuery("");
                        setScreenPage(0);
                        setExcludedPage(0);
                        setErrorPage(0);
                      }}
                    >
                      恢复默认候选视图
                    </Button>
                  </div>
                )}
                {!firstScreenPage && screened.isFetching && !screenResult && (
                  <p role="status">正在读取候选结果…</p>
                )}
                {screenResult ? (
                  <>
                    <p className="muted">
                      选股基准日：
                      {screenResult.asOf ?? "旧任务未记录统一基准日"} ·{" "}
                      {screenResult.elapsedMs !== undefined
                        ? `本地计算 ${(screenResult.elapsedMs / 1000).toFixed(2)} 秒`
                        : "旧版结果"}
                      。本地数据可能落后于今天；AI 研究在独立后台任务中执行。
                    </p>
                    {screenResult.dataHealth && (
                      <div className="notice">
                        <strong>
                          数据时效：
                          {screenResult.dataHealth.status === "aligned"
                            ? "与已知交易时点对齐"
                            : screenResult.dataHealth.status === "lagging"
                              ? "行情已落后"
                              : "当前时效未核验"}
                        </strong>
                        <p>
                          参考时点：
                          {screenResult.dataHealth.referenceAsOf ??
                            "未知"} · {screenResult.dataHealth.referenceSource}
                        </p>
                        <p>{screenResult.dataHealth.warnings.join("；")}</p>
                      </div>
                    )}
                    {screenResult.poolContext && (
                      <details>
                        <summary>
                          本次证券池分布：有效{" "}
                          {screenResult.poolContext.observed}/
                          {screenResult.poolContext.requested}，上涨{" "}
                          {screenResult.poolContext.up}、下跌{" "}
                          {screenResult.poolContext.down}、持平{" "}
                          {screenResult.poolContext.flat}
                        </summary>
                        <p>
                          高于 {screenResult.poolContext.fastBars} 根均线：
                          {screenResult.poolContext.aboveFast}；高于{" "}
                          {screenResult.poolContext.slowBars} 根均线：
                          {screenResult.poolContext.aboveSlow}。相邻 K
                          线涨跌中位数：
                          {screenResult.poolContext.medianChange === null
                            ? "未知"
                            : `${fmt(screenResult.poolContext.medianChange)}%`}
                          。
                        </p>
                        <p>{screenResult.poolContext.warnings.join("；")}</p>
                      </details>
                    )}
                    {screenResult.researchMode === "historical" && (
                      <p className="notice">
                        历史研究截止日：{screenResult.requestedAsOf}
                        ；证券池来源：{screenResult.universeSource}。
                        {screenResult.researchWarnings.join("；")}
                      </p>
                    )}
                    {screenResult.researchMode === "current" && (
                      <p className="notice">
                        严格当前模式：本次行情已对齐已知参考时点。个股交易状态和缺失区间仍需核验。
                      </p>
                    )}
                    <div className="inline-form">
                      <input
                        aria-label="筛选候选名称或代码"
                        placeholder="搜索候选名称或代码"
                        value={screenQuery}
                        onChange={(e) => {
                          setScreenQuery(e.target.value);
                          setScreenPage(0);
                        }}
                      />
                      <select
                        aria-label="候选排序字段"
                        value={screenSort}
                        onChange={(e) => {
                          setScreenSort(e.target.value as ScreenSort);
                          setScreenPage(0);
                        }}
                      >
                        {Object.entries(screenSortLabels).map(
                          ([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ),
                        )}
                      </select>
                      <select
                        aria-label="候选排序方向"
                        value={screenDirection}
                        disabled={screenSort === "original"}
                        onChange={(e) => {
                          setScreenDirection(e.target.value as "asc" | "desc");
                          setScreenPage(0);
                        }}
                      >
                        <option value="desc">从高到低</option>
                        <option value="asc">从低到高</option>
                      </select>
                      <Button
                        variant="outline"
                        disabled={screenPage === 0 || screened.isFetching}
                        onClick={() => setScreenPage(screenPage - 1)}
                      >
                        上一页
                      </Button>
                      <span>
                        第 {screenPage + 1} /{" "}
                        {Math.max(1, Math.ceil(screenResult.count / 50))} 页 ·{" "}
                        {screenResult.count} 条
                      </span>
                      <Button
                        variant="outline"
                        disabled={
                          (screenPage + 1) * 50 >= screenResult.count ||
                          screened.isFetching
                        }
                        onClick={() => setScreenPage(screenPage + 1)}
                      >
                        下一页
                      </Button>
                    </div>
                    {screened.isFetching && !firstScreenPage && (
                      <p role="status">
                        {screened.isPlaceholderData
                          ? "正在更新查询，表格暂时保留上次结果，请等待更新完成。"
                          : "正在更新候选结果…"}
                      </p>
                    )}
                    <div
                      className="table-wrap"
                      aria-busy={!firstScreenPage && screened.isFetching}
                    >
                      <table>
                        <thead>
                          <tr>
                            <th>证券</th>
                            <th>数据时间</th>
                            <th>收盘</th>
                            <th>涨跌幅</th>
                            <th>量比</th>
                            <th>趋势分</th>
                            <th>AI 快评</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {screenResult.candidates.map((c) => (
                            <tr key={c.symbol}>
                              <td>
                                <strong
                                  title={archivedNameHint(
                                    c.symbol,
                                    names,
                                    c.name,
                                  )}
                                >
                                  {securityDisplayName(c.symbol, names, c.name)}
                                </strong>
                                <small>{c.symbol}</small>
                              </td>
                              <td>{c.metrics.date}</td>
                              <td>{fmt(c.metrics.close)}</td>
                              <td
                                className={
                                  c.metrics.change >= 0 ? "up" : "down"
                                }
                              >
                                {fmt(c.metrics.change)}%
                              </td>
                              <td>{fmt(c.metrics.volumeRatio)}</td>
                              <td>{fmt(c.metrics.score)}</td>
                              <td>
                                {(() => {
                                  const review = reviews.data?.items.find(
                                    (r) => r.snapshotId === c.snapshotId,
                                  );
                                  return review ? (
                                    <div>
                                      <p>{review.summary}</p>
                                      <span className="tag">
                                        风险 {review.riskCount} 项 · 缺口{" "}
                                        {review.missingCount} 项
                                      </span>
                                      {review.risks.map((risk, i) => (
                                        <p key={i}>{risk}</p>
                                      ))}
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() =>
                                          setScreenReportId(review.reportId)
                                        }
                                      >
                                        查看完整快评
                                      </Button>
                                    </div>
                                  ) : (
                                    <span className="muted">
                                      {reviews.isFetching
                                        ? "正在读取快评…"
                                        : "暂无本任务快评"}
                                    </span>
                                  );
                                })()}
                              </td>
                              <td>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={
                                    !firstScreenPage &&
                                    (screened.isPlaceholderData ||
                                      screened.isError)
                                  }
                                  onClick={async () => {
                                    try {
                                      const source =
                                        await utils.savedSnapshot.fetch(
                                          c.snapshotId,
                                        );
                                      setTab("market");
                                      setSymbol(c.symbol);
                                      setPeriod(source.period);
                                      setLoaded(source);
                                    } catch (error) {
                                      notify(
                                        error instanceof Error
                                          ? error.message
                                          : "读取快照失败",
                                      );
                                    }
                                  }}
                                >
                                  研究 <ArrowUpRight size={13} />
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {reviews.error && (
                      <p role="alert">
                        快评读取失败：{reviews.error.message}
                        <Button onClick={() => void reviews.refetch()}>
                          重试快评
                        </Button>
                      </p>
                    )}
                    {screenReportId && (
                      <section>
                        <Button
                          variant="outline"
                          onClick={() => setScreenReportId("")}
                        >
                          收起完整快评
                        </Button>
                        {screenReport.isLoading && (
                          <p role="status">正在读取完整快评…</p>
                        )}
                        {screenReport.error && (
                          <p role="alert">
                            {screenReport.error.message}
                            <Button onClick={() => void screenReport.refetch()}>
                              重试报告
                            </Button>
                          </p>
                        )}
                        {screenReport.data && (
                          <ReportCard
                            report={screenReport.data}
                            securityContext={screenReport.data.securityContext}
                            names={names}
                          />
                        )}
                      </section>
                    )}
                    {!!screenResult.excludedTotal && (
                      <details>
                        <summary>
                          查看隔离原因（{screenResult.excludedTotal}）
                        </summary>
                        <ResultPager
                          page={excludedPage}
                          count={screenResult.excludedTotal}
                          onChange={setExcludedPage}
                        />
                        <div className="table-wrap">
                          <table>
                            <thead>
                              <tr>
                                <th>证券</th>
                                <th>数据时间</th>
                                <th>原因</th>
                              </tr>
                            </thead>
                            <tbody>
                              {screenResult.excluded.map((item) => (
                                <tr key={item.symbol}>
                                  <td>
                                    <span
                                      title={archivedNameHint(
                                        item.symbol,
                                        names,
                                        item.name,
                                      )}
                                    >
                                      {securityDisplayName(
                                        item.symbol,
                                        names,
                                        item.name,
                                      )}
                                    </span>
                                    <small>{item.symbol}</small>
                                  </td>
                                  <td>{item.date ?? "—"}</td>
                                  <td>{item.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                    {screenResult.errorTotal > 0 && (
                      <details>
                        <summary>
                          读取异常明细（{screenResult.errorTotal}）
                        </summary>
                        <ResultPager
                          page={errorPage}
                          count={screenResult.errorTotal}
                          onChange={setErrorPage}
                        />
                        <pre>
                          {JSON.stringify(screenResult.errors, null, 2)}
                        </pre>
                      </details>
                    )}
                  </>
                ) : (
                  screenJob?.status !== "completed" && (
                    <Empty>
                      运行规则筛选，结果会附带数据时间；前 10 个候选默认自动进行
                      AI 分析。
                    </Empty>
                  )
                )}
              </section>
            </>
          )}
          {tab === "backtest" && (
            <>
              <section className="panel">
                <div className="panel-title">
                  <FlaskConical size={18} />
                  <h3>双均线研究模拟</h3>
                  <span className="tag">{loaded?.symbol ?? "先加载行情"}</span>
                </div>
                <div className="notice">
                  <TriangleAlert size={17} />
                  <span>
                    当前为不复权研究模拟。跨除权事件、涨跌停排队与历史费用尚未完整还原，结果不作为正式策略业绩。
                  </span>
                </div>
                <StrategyFields strategy={strategy} setStrategy={setStrategy} />
                <div className="inline-form">
                  <Field label="初始资金">
                    <input
                      type="number"
                      value={initial}
                      onChange={(e) => setInitial(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="回测数据范围">
                    <select
                      value={backtestScope}
                      onChange={(e) =>
                        setBacktestScope(e.target.value as "full" | "window")
                      }
                    >
                      <option value="full">
                        完整本地历史（截至所选快照末尾）
                      </option>
                      <option value="window">仅当前快照窗口</option>
                    </select>
                  </Field>
                  <Button
                    disabled={!loaded || runBacktest.isPending}
                    onClick={() =>
                      loaded &&
                      runBacktest.mutate({
                        snapshotId: loaded.id,
                        strategy,
                        initial,
                        scope: backtestScope,
                        costs: backtestCosts,
                      })
                    }
                  >
                    <Play size={15} />
                    运行回测
                  </Button>
                </div>
                <details>
                  <summary>交易成本（固定实验参数）</summary>
                  <p className="muted">
                    费用不随交易日期自动变化，不代表历史实际费率；过户费等其他杂费尚未单独建模。
                  </p>
                  <div className="form-grid">
                    {(
                      [
                        ["commissionBps", "佣金（万分之）"],
                        ["minimumCommission", "最低佣金（元）"],
                        ["sellTaxBps", "卖出税费（万分之）"],
                        ["slippageBps", "单边滑点（万分之）"],
                      ] as const
                    ).map(([key, label]) => (
                      <Field key={key} label={label}>
                        <input
                          type="number"
                          min={0}
                          step="0.1"
                          value={backtestCosts[key]}
                          onChange={(e) =>
                            setBacktestCosts({
                              ...backtestCosts,
                              [key]: Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                    ))}
                  </div>
                </details>
                <p className="muted">
                  {loaded
                    ? `所选快照 ${loaded.bars.length} 根：${loaded.bars[0]?.date} 至 ${loaded.bars.at(-1)?.date}。${backtestScope === "full" ? "将读取截至该末尾时点的完整本地历史，并核对所选窗口未被修订。" : "仅使用所选窗口，不代表完整历史。"}`
                    : "前往行情研究加载证券，再运行回测。"}
                </p>
              </section>
              <WalkForwardPanel
                snapshot={loaded ?? undefined}
                strategy={strategy}
                initial={initial}
                costs={backtestCosts}
                scope={backtestScope}
              />
              {bt && (
                <section className="panel">
                  <p className="muted">
                    {bt.costs
                      ? `引擎 ${bt.engineVersion} · 成本版本 ${bt.costs.version} · 佣金万分之 ${bt.costs.commissionBps}（最低 ${bt.costs.minimumCommission} 元） · 卖出税费万分之 ${bt.costs.sellTaxBps} · 滑点万分之 ${bt.costs.slippageBps}`
                      : "旧结果未保存独立成本版本，请查看其原始假设。"}
                  </p>
                  <p className="muted">
                    {bt.dataRange
                      ? `${bt.dataRange.scope === "full" ? "完整本地历史" : "快照窗口"} · ${bt.dataRange.bars} 根 · ${bt.dataRange.start} 至 ${bt.dataRange.end}`
                      : "旧回测未记录完整数据范围，请结合原快照核验。"}
                  </p>
                  <div className="result-stats">
                    <div>
                      <span>模拟区间收益</span>
                      <strong className={bt.totalReturn >= 0 ? "up" : "down"}>
                        {fmt(bt.totalReturn)}%
                      </strong>
                    </div>
                    <div>
                      <span>最大回撤</span>
                      <strong>{fmt(bt.maxDrawdown)}%</strong>
                    </div>
                    <div>
                      <span>成交记录</span>
                      <strong>{bt.trades.length}</strong>
                    </div>
                    <div>
                      <span>期末持仓</span>
                      <strong>{bt.shares} 股</strong>
                    </div>
                  </div>
                  <PriceChart equity={bt.equity} />
                  <DividendLedgerPanel result={bt} />
                  <BacktestActionsPanel
                    review={bt.corporateActions}
                    base={bt}
                  />
                  {bt.benchmark ? (
                    <p className="muted">
                      {bt.benchmark.label}：收益 {fmt(bt.benchmark.totalReturn)}
                      % · 最大回撤 {fmt(bt.benchmark.maxDrawdown)}% · 策略超额
                      {fmt(bt.benchmark.excessReturnPoints)} 个百分点 ·
                      {bt.benchmark.trade
                        ? `建仓 ${bt.benchmark.trade.date}，${bt.benchmark.shares} 股`
                        : "窗口内未能买入，基准持有现金"}
                    </p>
                  ) : (
                    <p className="muted">旧回测未保存买入持有基准。</p>
                  )}
                  {bt.diagnostics && (
                    <p className="muted">
                      入场条件满足 {bt.diagnostics.entrySignals} 次 ·
                      资金不足以买入一手 {bt.diagnostics.insufficientCash} 次 ·
                      无量或一字 K 线 {bt.diagnostics.untradable} 次
                    </p>
                  )}
                  <details open>
                    <summary>计算假设与边界</summary>
                    <ul>
                      {bt.assumptions.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  </details>
                  <details>
                    <summary>成交记录</summary>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>日期</th>
                            <th>方向</th>
                            <th>价格</th>
                            <th>股数</th>
                            <th>费用</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bt.trades.map((t, i) => (
                            <tr key={i}>
                              <td>{t.date}</td>
                              <td>{t.side === "buy" ? "买入" : "卖出"}</td>
                              <td>{fmt(t.price)}</td>
                              <td>{t.shares}</td>
                              <td>{fmt(t.fee)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                </section>
              )}
            </>
          )}
          {tab === "signals" && (
            <>
              <section className="panel">
                <div className="panel-title">
                  <Radio size={18} />
                  <h3>新建监控订阅</h3>
                </div>
                <div className="form-grid">
                  <Field label="监控名称">
                    <input
                      value={monitorName}
                      onChange={(e) => setMonitorName(e.target.value)}
                    />
                  </Field>
                  <Field label="证券池（留空使用自选）">
                    <input
                      value={universe}
                      onChange={(e) => setUniverse(e.target.value)}
                      placeholder={watchlist.join(",")}
                    />
                  </Field>
                  <Field label="监控策略">
                    <select
                      aria-label="监控策略"
                      value={monitorType}
                      onChange={(e) => {
                        setMonitorType(
                          e.target.value as
                            "ma-cross" | "czsc" | "dual-breakout",
                        );
                        if (e.target.value !== "ma-cross") setPeriod("day");
                      }}
                    >
                      <option value="ma-cross">双均线趋势</option>
                      <option value="czsc">缠论买卖点（确认及以上）</option>
                      <option value="dual-breakout">双突破（日线）</option>
                    </select>
                  </Field>
                  <Field label="周期">
                    <select
                      value={monitorType !== "ma-cross" ? "day" : period}
                      disabled={monitorType !== "ma-cross"}
                      onChange={(e) => setPeriod(e.target.value as Period)}
                    >
                      <option value="day">日线</option>
                      <option value="5m">五分钟线</option>
                    </select>
                  </Field>
                </div>
                {monitorType === "ma-cross" ? (
                  <StrategyFields
                    strategy={strategy}
                    setStrategy={setStrategy}
                  />
                ) : (
                  <p className="muted">
                    日线 15:05 后检查一、二、三类买卖点；使用严格笔中枢（配置
                    0），仅确认及强质量。
                  </p>
                )}
                <Field label="监控数据源">
                  <select
                    value={monitorSource}
                    onChange={(e) =>
                      setMonitorSource(e.target.value as "local" | "mcp")
                    }
                  >
                    <option value="mcp">通达信 MCP（最新行情）</option>
                    <option value="local">本地通达信文件（需自行更新）</option>
                  </select>
                </Field>
                <div className="check-row">
                  {channels.data?.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={monitorChannels.includes(c.id)}
                        onChange={(e) =>
                          setMonitorChannels(
                            e.target.checked
                              ? [...monitorChannels, c.id]
                              : monitorChannels.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                      {!c.enabled ? "（渠道未启用）" : ""}
                    </label>
                  ))}
                  <label>
                    <input
                      type="checkbox"
                      checked={monitorAi}
                      onChange={(e) => setMonitorAi(e.target.checked)}
                    />
                    信号后附加 AI 解读
                  </label>
                </div>
                <Button
                  onClick={() =>
                    saveMonitor.mutate({
                      name: monitorName,
                      symbols: symbols() ?? watchlist,
                      strategy:
                        monitorType === "dual-breakout"
                          ? { type: "dual-breakout", params: {} }
                          : monitorType === "czsc"
                            ? { type: "czsc", params: { config: 0 } }
                            : strategy,
                      period: monitorType !== "ma-cross" ? "day" : period,
                      source: monitorSource,
                      channels: monitorChannels,
                      ai: monitorAi,
                      enabled: true,
                    })
                  }
                >
                  <Plus size={15} />
                  启用监控
                </Button>
                <p className="muted">
                  首次建立基线，不发送历史信号。需要本交易日已完成行情；MCP
                  监控自动查询，本地模式需通达信更新文件。新信号还需通过同花顺问财当日交易状态核验，未知或停牌时暂停该证券信号。点击窗口右上角
                  × 会退出应用并停止监控，电脑休眠时也会停止监控。
                </p>
              </section>
              <section className="panel">
                <div className="panel-title">
                  <h3>运行中的订阅</h3>
                </div>
                {monitors.data?.length ? (
                  monitors.data.map((m) => (
                    <div className="list-row" key={m.id}>
                      <div>
                        <strong>{m.name}</strong>
                        <p>
                          {m.symbols
                            .map(
                              (s) =>
                                `${securityDisplayName(s, names)} (${s.toUpperCase()})`,
                            )
                            .join("、")}{" "}
                          · {m.period} · {m.source === "mcp" ? "MCP" : "本地"} ·{" "}
                          {m.error ??
                            (m.lastCheck
                              ? `检查于 ${stamp(m.lastCheck)}`
                              : "等待首次检查")}
                        </p>
                        <CalendarEvidence evidence={m.calendarEvidence} />
                        {Object.values(m.tradingStatusChecks ?? {}).map(
                          (check) => (
                            <TradingStatusEvidence
                              key={check.symbol}
                              value={check}
                            />
                          ),
                        )}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          toggleMonitor.mutate({
                            id: m.id,
                            enabled: !m.enabled,
                          })
                        }
                      >
                        {m.enabled ? "暂停" : "启用"}
                      </Button>
                    </div>
                  ))
                ) : (
                  <Empty>添加一个策略订阅，开始跟踪新信号。</Empty>
                )}
              </section>
              <section className="panel">
                <div className="panel-title">
                  <h3>信号记录</h3>
                  <span className="tag">{signals.data?.length ?? 0}</span>
                </div>
                {signals.data?.length ? (
                  signals.data.map((s) => (
                    <div className="list-row" key={s.id}>
                      <div>
                        <strong>
                          {securityDisplayName(s.symbol, names)} (
                          {s.symbol.toUpperCase()}) · {s.strategy.name}
                        </strong>
                        <p>
                          {s.date} · 收盘 {fmt(s.metrics.close)} · {s.id}
                        </p>
                        <CalendarEvidence evidence={s.calendarEvidence} />
                        <TradingStatusEvidence
                          value={s.tradingStatusEvidence}
                        />
                      </div>
                      <span className="tag">规则触发</span>
                    </div>
                  ))
                ) : (
                  <Empty>尚无新信号。历史导入与回测不会发送通知。</Empty>
                )}
              </section>
              <section className="panel">
                <div className="panel-title">
                  <Send size={17} />
                  <h3>投递历史</h3>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setTab("settings")}
                  >
                    管理渠道 <ChevronRight size={13} />
                  </Button>
                </div>
                {deliveries.data?.length ? (
                  deliveries.data.map((d) => (
                    <div className="list-row" key={d.id}>
                      <div>
                        <strong>
                          {d.title} ·{" "}
                          {channels.data?.find((c) => c.id === d.channelId)
                            ?.name ?? d.channelId}
                        </strong>
                        <p>
                          {stamp(d.createdAt)} · 尝试 {d.attempts} 次 ·{" "}
                          {d.error ?? d.remoteId ?? ""}
                        </p>
                        <details>
                          <summary>消息内容</summary>
                          <pre>{d.body}</pre>
                        </details>
                      </div>
                      <span className="tag">
                        {
                          {
                            pending: "待发送",
                            sending: "发送中",
                            sent: "平台已接受",
                            failed: "失败",
                            expired: "已过期",
                            cancelled: "已取消",
                          }[d.status]
                        }
                      </span>
                      {["failed", "expired", "cancelled"].includes(
                        d.status,
                      ) && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => retry.mutate(d.id)}
                        >
                          手动重发
                        </Button>
                      )}
                    </div>
                  ))
                ) : (
                  <Empty>配置并启用渠道后，新信号将在此显示投递状态。</Empty>
                )}
              </section>
            </>
          )}
          {tab === "reports" && (
            <>
              <CanslimPanel archive />
              <ChanPanel archive />
              <WyckoffPanel archive />
              <ValuationPanel key={symbol} symbol={symbol} />
              <FinancialQualityPanel
                key={`financial-${symbol}`}
                symbol={symbol}
                snapshot={loaded ?? undefined}
              />
              <ReportArchive names={names} active={activeJobs.length > 0} />
            </>
          )}
          {tab === "settings" && status.data && (
            <Connections
              value={status.data.settings}
              channels={channels.data ?? []}
              coverage={status.data.coverage}
              notify={notify}
            />
          )}
          <section className="task-bar">
            <div className="panel-title">
              <Workflow size={16} />
              <h3>任务中心</h3>
              <span className="tag">{activeJobs.length} 进行中</span>
            </div>
            <TaskHistory />
            <p className="muted">
              下列为任务摘要；完整阶段与错误可在“全部任务与失败详情”中查看。
            </p>
            {jobs.data?.slice(0, 8).map((j) => (
              <div className="task-row" key={j.id}>
                <span className="task-icon">
                  {j.status === "running" ? (
                    <LoaderCircle size={14} className="spin" />
                  ) : j.status === "completed" ? (
                    <Check size={14} />
                  ) : j.status === "failed" ? (
                    <TriangleAlert size={14} />
                  ) : (
                    <Square size={12} />
                  )}
                </span>
                <strong>
                  {
                    {
                      scan: "数据扫描",
                      screen: "条件选股",
                      "online-screen": "在线筛选",
                      backtest: "策略回测",
                      "walk-forward": "滚动检验",
                      research: "AI 研究",
                      monitor: "策略监控",
                    }[j.type]
                  }
                </strong>
                <span>
                  {j.error ??
                    {
                      queued: "等待运行",
                      running: `${j.phase ?? "进行中"} · ${j.progress}%`,
                      completed: "已完成",
                      failed: "失败",
                      cancelled: "已取消",
                    }[j.status]}
                </span>
                <small>{stamp(j.createdAt)}</small>
                {["queued", "running"].includes(j.status) && (
                  <button
                    className="text-link"
                    onClick={() => cancel.mutate(j.id)}
                  >
                    取消
                  </button>
                )}
              </div>
            ))}
          </section>
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

function Connections({
  value,
  channels,
  coverage,
  notify,
}: {
  value: Settings;
  channels: Channel[];
  coverage: {
    counts: Record<string, number>;
    scannedAt: number;
    total: number;
  } | null;
  notify: (s: string) => void;
}) {
  const budget = api.newsBudget.useQuery(undefined, { refetchInterval: 30000 });
  const skillCatalog = api.researchSkills.useQuery(undefined, {
    staleTime: 60000,
  });
  const directory = api.securityNames.useQuery(undefined, {
    staleTime: 60000,
    refetchInterval: 300000,
  });
  const names = directory.data ?? {};
  const utils = api.useUtils(),
    [config, setConfig] = useState(value),
    [channel, setChannel] = useState({
      name: "",
      type: "feishu" as Channel["type"],
      target: "",
      thread: "",
      secret: "",
      signingSecret: "",
      enabled: false,
    }),
    [editId, setEditId] = useState<string | undefined>(),
    [tools, setTools] = useState<
      { name: string; description?: string; schema: unknown }[]
    >([]),
    [toolName, setToolName] = useState(""),
    [args, setArgs] = useState("{}"),
    [mcpResult, setMcpResult] = useState("");
  const mcpHealth = api.mcpHealth.useQuery(undefined, { staleTime: 30000 });
  const onError = (e: { message: string }) => notify(e.message),
    save = api.saveSettings.useMutation({
      onSuccess: () => {
        notify("设置已保存");
        void utils.status.invalidate();
        void utils.securityProfile.invalidate();
        void utils.securityNames.invalidate();
        void utils.securities.invalidate();
      },
      onError,
    }),
    saveChannel = api.saveChannel.useMutation({
      onSuccess: () => {
        notify("渠道已保存，尚未发送测试消息");
        setChannel({ ...channel, secret: "", signingSecret: "" });
        void utils.channels.invalidate();
      },
      onError,
    }),
    test = api.testChannel.useMutation({
      onSuccess: () => notify("测试通知已加入发送队列，请查看投递历史"),
      onError,
    }),
    importMcp = api.importMcp.useMutation({
      onSuccess: () => {
        notify("本机 MCP 配置已导入加密存储");
        void utils.status.invalidate();
      },
      onError,
    }),
    listTools = api.mcpTools.useMutation({
      onSettled: () => {
        void utils.mcpHealth.invalidate();
      },
      onSuccess: (t) => {
        setTools(t);
        notify(`已发现 ${t.length} 个允许使用的数据工具`);
      },
      onError,
    }),
    query = api.mcpQuery.useMutation({
      onSuccess: (r) => setMcpResult(JSON.stringify(r, null, 2)),
      onError,
    });
  return (
    <>
      <NewsPanel />
      <section className="panel">
        <div className="panel-title">
          <Sparkles size={18} />
          <h3>研究技能</h3>
        </div>
        <p>
          自动快评按量价方法每批分析最多 5
          只。其他已登记技能会在对应研究模块接入后开放，登记不代表已执行完整流程。
        </p>
        <details>
          <summary>
            查看技能登记与版本（{skillCatalog.data?.length ?? 0}）
          </summary>
          {skillCatalog.error && <p>{skillCatalog.error.message}</p>}
          <div className="max-h-80 overflow-auto">
            {skillCatalog.data?.map((skill) => (
              <div className="list-row" key={skill.skillId}>
                <div>
                  <strong>{skill.skillId}</strong>
                  <small>
                    {skill.ruleVersion ?? "流程待接入"} ·{" "}
                    {skill.hash?.slice(0, 16) ?? "未找到文件"}
                  </small>
                  <small>{skill.integrationScope}</small>
                  <small>前提：{skill.prerequisites.join("；")}</small>
                  <small>调用预算：{skill.budget}</small>
                  {skill.missingFiles.length > 0 && (
                    <small>缺少文件：{skill.missingFiles.join("、")}</small>
                  )}
                </div>
                <span className="tag">
                  {skill.status === "quick-review"
                    ? "量价快评"
                    : skill.status === "staged-research"
                      ? "分阶段研究"
                      : skill.status === "adapter"
                        ? "部分数据接入"
                        : skill.status === "incomplete"
                          ? "依赖不完整"
                          : skill.installed
                            ? "已登记"
                            : "未安装"}
                </span>
              </div>
            ))}
          </div>
        </details>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Database size={18} />
          <h3>本地行情</h3>
          <span className="tag">只读接入</span>
        </div>
        <Field label="财联社新闻数据库路径">
          <input
            value={config.clsDbPath}
            onChange={(e) =>
              setConfig({ ...config, clsDbPath: e.target.value })
            }
          />
        </Field>
        <Field label="新闻自动研究">
          <span>
            <input
              type="checkbox"
              checked={config.autoNewsAnalysis}
              onChange={(e) =>
                setConfig({ ...config, autoNewsAnalysis: e.target.checked })
              }
            />
            自动分析最近七天新闻（每分钟最多50条，使用当前模型；失败后等待15分钟）
          </span>
        </Field>
        <Field label="通达信安装目录">
          <input
            value={config.tdxRoot}
            onChange={(e) => setConfig({ ...config, tdxRoot: e.target.value })}
          />
        </Field>
        <Field label="自动新闻每日AI批次上限（北京时间）">
          <input
            type="number"
            min={1}
            max={100}
            value={config.autoNewsDailyBatches}
            onChange={(e) =>
              setConfig({
                ...config,
                autoNewsDailyBatches: Number(e.target.value),
              })
            }
          />
          <small>
            每批最多25条，含最多一次格式修复重试；缓存复用不计，失败计入额度，次日恢复。不是套餐Token余额。
          </small>
          {budget.data && (
            <small>
              {budget.data.day} 已用 {budget.data.used}/{budget.data.limit} 批 ·{" "}
              {budget.data.exhausted
                ? "额度已用完，自动研究暂停至次日"
                : "额度可用"}
            </small>
          )}
        </Field>
        <div className="coverage-grid">
          {Object.entries(coverage?.counts ?? {}).map(([name, count]) => (
            <div key={name}>
              <span>{name.replace("day", "日线").replace("5m", "五分钟")}</span>
              <strong>{count.toLocaleString()}</strong>
              <small>行情文件</small>
            </div>
          ))}
        </div>
        <p className="muted">
          {coverage
            ? `最近扫描 ${stamp(coverage.scannedAt)} · ${coverage.total} 个 A 股周期记录`
            : "尚未扫描，保存目录后点击页面右上角扫描。"}
        </p>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Sparkles size={18} />
          <h3>研究模型</h3>
        </div>
        <p className="muted">
          Codex / Claude Code 复用本机 CLI
          的订阅登录，使用对应套餐额度。请先在终端登录，再启动应用。失败不会自动切换
          DeepSeek。
        </p>
        <div className="form-grid">
          <Field label="模型提供方">
            <select
              value={config.llmProvider}
              onChange={(e) =>
                setConfig({
                  ...config,
                  llmProvider: e.target.value as Settings["llmProvider"],
                })
              }
            >
              <option value="codex">Codex（默认 · 本机订阅）</option>
              <option value="claude">Claude Code（本机订阅）</option>
              <option value="deepseek">DeepSeek（API）</option>
            </select>
          </Field>
          {config.llmProvider === "deepseek" ? (
            <>
              <Field label="轻量模型">
                <input
                  value={config.fastModel}
                  onChange={(e) =>
                    setConfig({ ...config, fastModel: e.target.value })
                  }
                />
              </Field>
              <Field label="深度模型">
                <input
                  value={config.deepModel}
                  onChange={(e) =>
                    setConfig({ ...config, deepModel: e.target.value })
                  }
                />
              </Field>
              <p className="muted">
                使用 DEEPSEEK_API_KEY 环境变量；仅选择此提供方时调用 API。
              </p>
            </>
          ) : (
            <Field label="CLI 模型（留空使用默认模型）">
              <input
                value={
                  config.llmProvider === "codex"
                    ? config.codexModel
                    : config.claudeModel
                }
                placeholder="使用 CLI 默认模型"
                onChange={(e) =>
                  setConfig({
                    ...config,
                    [config.llmProvider === "codex"
                      ? "codexModel"
                      : "claudeModel"]: e.target.value,
                  })
                }
              />
            </Field>
          )}
          <Field label="自动分析候选数（1–10）">
            <input
              type="number"
              min={1}
              max={10}
              value={config.analysisLimit}
              onChange={(e) =>
                setConfig({ ...config, analysisLimit: Number(e.target.value) })
              }
            />
          </Field>
        </div>
        <div className="check-row">
          <label>
            <input
              type="checkbox"
              checked={config.autoAnalysis}
              onChange={(e) =>
                setConfig({ ...config, autoAnalysis: e.target.checked })
              }
            />
            选股和回测完成后自动分析
          </label>
        </div>
        <Field label="聊天渠道出站代理（可选）">
          <input
            value={config.proxy}
            onChange={(e) => setConfig({ ...config, proxy: e.target.value })}
            placeholder="http://127.0.0.1:7890"
          />
        </Field>
        <details>
          <summary>交易日历覆盖</summary>
          <p>
            默认读取本地上证指数日线中的交易日期。若需覆盖，输入已确认的交易日期，每行一个；空白表示使用默认来源。
          </p>
          <textarea
            rows={4}
            value={config.calendar.join("\n")}
            onChange={(e) =>
              setConfig({
                ...config,
                calendar: e.target.value.split(/\s+/).filter(Boolean),
              })
            }
          />
        </details>
        <Button onClick={() => save.mutate(config)} disabled={save.isPending}>
          保存设置
        </Button>
      </section>
      <section className="panel">
        <div className="panel-title">
          <Workflow size={18} />
          <h3>通达信 MCP</h3>
        </div>
        <p>
          从本机 Codex 配置导入服务地址与认证，使用 Node.js
          直接连接。认证过期后更新本机配置并重新导入。
        </p>
        <div className="button-row">
          <Button
            variant="outline"
            onClick={() => importMcp.mutate()}
            disabled={importMcp.isPending}
          >
            导入本机配置
          </Button>
          <Button
            variant="outline"
            onClick={() => listTools.mutate()}
            disabled={listTools.isPending}
          >
            检测连接与工具
          </Button>
        </div>
        <p className="muted">
          {mcpHealth.data
            ? `最近检测：${mcpHealth.data.status === "available" ? "工具发现成功" : "检测失败"} · ${stamp(mcpHealth.data.checkedAt)} · ${mcpHealth.data.latencyMs} ms`
            : "尚未检测服务。已导入配置不代表连接可用。"}
        </p>
        {mcpHealth.data && (
          <details>
            <summary>连接检测记录与工具版本</summary>
            <p>{mcpHealth.data.message}</p>
            <p>
              最近成功：
              {mcpHealth.data.lastSuccessAt
                ? stamp(mcpHealth.data.lastSuccessAt)
                : "无"}
            </p>
            <p>
              与上次成功检测相比：新增{" "}
              {mcpHealth.data.changes.added.join("、") || "无"}；移除{" "}
              {mcpHealth.data.changes.removed.join("、") || "无"}；结构变化{" "}
              {mcpHealth.data.changes.changed.join("、") || "无"}。
            </p>
            <pre>
              {mcpHealth.data.tools
                .map((tool) => `${tool.name}: ${tool.schemaHash}`)
                .join("\n")}
            </pre>
          </details>
        )}
        {tools.length > 0 && (
          <details>
            <summary>数据工具查询</summary>
            <select
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
            >
              <option value="">选择工具</option>
              {tools.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
            <pre>
              {JSON.stringify(
                tools.find((t) => t.name === toolName)?.schema,
                null,
                2,
              )}
            </pre>
            <Field label="查询参数 JSON">
              <textarea
                rows={5}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </Field>
            <Button
              onClick={() => {
                try {
                  query.mutate({
                    name: toolName,
                    args: JSON.parse(args) as Record<string, unknown>,
                  });
                } catch {
                  notify("参数必须是合法 JSON");
                }
              }}
            >
              查询
            </Button>
            <pre>{mcpResult}</pre>
          </details>
        )}
      </section>
      <section className="panel">
        <div className="panel-title">
          <Send size={18} />
          <h3>聊天推送渠道</h3>
        </div>
        {channels.map((c) => (
          <div className="list-row" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <p>
                {c.type} · {c.enabled ? "已启用" : "已暂停"} · 凭证已加密保存
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditId(c.id);
                setChannel({
                  name: c.name,
                  type: c.type,
                  target: c.target,
                  thread: c.thread,
                  enabled: c.enabled,
                  secret: "",
                  signingSecret: "",
                });
              }}
            >
              编辑
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => test.mutate(c.id)}
            >
              发送测试通知
            </Button>
          </div>
        ))}
        <h4>{editId ? "编辑渠道" : "添加渠道"}</h4>
        <div className="form-grid">
          <Field label="渠道名称">
            <input
              value={channel.name}
              onChange={(e) => setChannel({ ...channel, name: e.target.value })}
            />
          </Field>
          <Field label="平台">
            <select
              value={channel.type}
              onChange={(e) =>
                setChannel({
                  ...channel,
                  type: e.target.value as Channel["type"],
                })
              }
            >
              <option value="feishu">飞书群机器人</option>
              <option value="wecom">企业微信群机器人</option>
              <option value="telegram">Telegram Bot</option>
              <option value="discord">Discord Webhook</option>
            </select>
          </Field>
        </div>
        <Field
          label={
            channel.type === "telegram" ? "Bot Token" : "机器人 Webhook 地址"
          }
        >
          <input
            type="password"
            autoComplete="new-password"
            value={channel.secret}
            onChange={(e) => setChannel({ ...channel, secret: e.target.value })}
            placeholder={
              editId ? "留空保留已有凭证" : "凭证仅保存到系统加密存储"
            }
          />
        </Field>
        {channel.type === "feishu" && (
          <Field label="签名密钥（可选）">
            <input
              type="password"
              value={channel.signingSecret}
              onChange={(e) =>
                setChannel({ ...channel, signingSecret: e.target.value })
              }
            />
          </Field>
        )}
        {channel.type === "telegram" && (
          <Field label="Chat ID（私聊需先联系机器人）">
            <input
              value={channel.target}
              onChange={(e) =>
                setChannel({ ...channel, target: e.target.value })
              }
            />
          </Field>
        )}
        {["telegram", "discord"].includes(channel.type) && (
          <Field label="话题 / Thread ID（可选）">
            <input
              value={channel.thread}
              onChange={(e) =>
                setChannel({ ...channel, thread: e.target.value })
              }
            />
          </Field>
        )}
        <div className="check-row">
          <label>
            <input
              type="checkbox"
              checked={channel.enabled}
              onChange={(e) =>
                setChannel({ ...channel, enabled: e.target.checked })
              }
            />
            启用此渠道接收订阅信号
          </label>
        </div>
        <div className="button-row">
          <Button
            onClick={() =>
              saveChannel.mutate({
                ...channel,
                id: editId,
                secret: channel.secret || undefined,
              })
            }
            disabled={saveChannel.isPending}
          >
            保存渠道
          </Button>
          {editId && (
            <Button
              variant="ghost"
              onClick={() => {
                setEditId(undefined);
                setChannel({
                  name: "",
                  type: "feishu",
                  target: "",
                  thread: "",
                  secret: "",
                  signingSecret: "",
                  enabled: false,
                });
              }}
            >
              取消编辑
            </Button>
          )}
        </div>
        <p className="muted">
          单向通知，无需公网回调地址。保存不会发送消息；点击“发送测试通知”才会向所选目标发送测试内容。
        </p>
      </section>
    </>
  );
}

function ResultPager({
  page,
  count,
  onChange,
}: {
  page: number;
  count: number;
  onChange: (page: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Button
        variant="ghost"
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span>
        第 {page + 1} / {Math.max(1, Math.ceil(count / 50))} 页 · {count} 条
      </span>
      <Button
        variant="ghost"
        disabled={(page + 1) * 50 >= count}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  );
}
