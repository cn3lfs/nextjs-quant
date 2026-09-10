import { useEffect, useState } from "react";
import { defaultBacktestCosts } from "~/lib/backtest-costs";
import {
  defaultStrategy,
  type Backtest,
  type Period,
  type Snapshot,
  type Strategy,
} from "~/lib/domain";
import { type ScreenSort } from "~/lib/screen-sort";
import { api } from "~/trpc/react";
import type { Tab } from "./navigation";
// Keep all original state, effects and queries in one unconditional hook so tab switches
// retain their original lifetimes. Views only receive the fields they render.
export function useWorkbenchState() {
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
  const selectFormulaJob = (id: string) => {
    setScreenId(id); setExcludedPage(0); setErrorPage(0); setScreenPage(0); setScreenQuery("");
    setScreenSort("original");
    void utils.jobs.invalidate();
  };
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

  return {
    setTab,
    loaded,
    strategy,
    question,
    setQuestion,
    researchMethod,
    setResearchMethod,
    status,
    analyze,
    symbol,
    setSymbol,
    period,
    setPeriod,
    names,
    verifyIdentity,
    identity,
    load,
    watch,
    last,
    change,
    watchlist,
    setLoaded,
    setStrategy,
    onlineQuery,
    setOnlineQuery,
    prompt,
    setPrompt,
    universe,
    setUniverse,
    historicalDate,
    setHistoricalDate,
    universeSource,
    setUniverseSource,
    requireCurrent,
    setRequireCurrent,
    screenPage,
    setScreenPage,
    excludedPage,
    setExcludedPage,
    errorPage,
    setErrorPage,
    screenQuery,
    setScreenQuery,
    screenReportId,
    setScreenReportId,
    screenSort,
    setScreenSort,
    screenDirection,
    setScreenDirection,
    utils,
    jobs,
    notify,
    screen,
    selectFormulaJob,
    interpret,
    screenJob,
    firstScreenPage,
    screened,
    exportingScreen,
    exportScreen,
    screenResult,
    reviews,
    screenReport,
    draft,
    symbols,
    initial,
    setInitial,
    backtestScope,
    setBacktestScope,
    backtestCosts,
    setBacktestCosts,
    runBacktest,
    bt,
    channels,
    monitors,
    signals,
    deliveries,
    saveMonitor,
    toggleMonitor,
    retry,
    monitorType,
    setMonitorType,
    monitorName,
    setMonitorName,
    monitorChannels,
    setMonitorChannels,
    monitorAi,
    setMonitorAi,
    monitorSource,
    setMonitorSource,
    activeJobs,
    scan,
    cancel,
    tab,
    toast,
    setToast,
  };
}
export type WorkbenchState = ReturnType<typeof useWorkbenchState>;
