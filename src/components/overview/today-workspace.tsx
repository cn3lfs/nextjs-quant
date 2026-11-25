"use client";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api } from "~/trpc/react";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  MethodologyPopover,
  Panel,
  Segmented,
  StateBanner,
  type MethodologyItem,
} from "../panels";
import { Button } from "../ui/button";
import { alertModeLabel } from "~/lib/common/ui-glossary";
import { CandidateTable, type WorkspaceCandidate } from "./candidate-table";
import { useSecurityNames } from "../market/use-security-names";
import {
  candidateView,
  dailyMainAction,
  isTodayBatch,
  PENDING_CANDIDATE_MESSAGE,
  selectMarket,
  todayMarketOptions,
  type MarketFilter,
} from "./today-candidates";
import {
  CandidatePlan,
  type PlanSavedConfirmation,
} from "../signals/candidate-plan";
import { PlanSavedNotice } from "./plan-saved-notice";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { LedgerSelect } from "../signals/ledger-fields";
import { DataTable } from "../ui/data-table";
import { useAccumulatedPages } from "../ui/use-infinite-table";
import { useScreenVisible } from "../workbench/use-task-visible";
import { AccountRiskLinks } from "../portfolio/account-risk-links";
import { RiskDistanceBar } from "../portfolio/risk-distance-bar";
import type { CloseScanPhase } from "~/lib/market/close-scan-window";
import { strategyMethodInfo } from "~/lib/strategy-facts/strategy-display";
const Overview = dynamic(() =>
  import("./today-overview").then((m) => m.TodayOverview),
);
const MarketConditions = dynamic(() =>
  import("./today-overview").then((m) => m.MarketConditions),
);
const WorkspaceNews = dynamic(() =>
  import("./workspace-news").then((m) => m.WorkspaceNews),
);
const RebalanceTicketPanel = dynamic(() =>
  import("./rebalance-ticket-panel").then((m) => m.RebalanceTicketPanel),
);
const Intraday = dynamic(() =>
  import("../workbench/route-panels").then((m) => m.IntradayPanel),
);
const PipelineConsole = dynamic(() =>
  import("../pipeline/pipeline-console").then((m) => m.PipelineConsole),
);
const closeScanLabel: Record<CloseScanPhase, string> = {
  "unknown-date": "基准交易日未知",
  waiting: "等待收盘",
  unconfirmed: "等待或未确认",
  running: "扫描中",
  missed: "已错过（不补跑）",
  complete: "流程已结束",
};

type TodayTab = "today" | "overview" | "intraday" | "pipeline";

/** One of the six fixed summary cells; unknown values stay an em dash. */
function RibbonCell({
  label,
  value,
  unit,
  note,
  href,
  tone,
  title,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  note: string;
  href?: string;
  tone?: "warn";
  title?: string;
}) {
  const body = (
    <>
      <span className="nc-ribbon-label">{label}</span>
      <span
        className={`nc-ribbon-value${tone === "warn" ? " text-nc-warn" : ""}`}
      >
        {value === null ? "—" : value}
        {value !== null && unit && (
          <span className="text-sub ml-0.5 font-normal text-nc-text-4">
            {unit}
          </span>
        )}
      </span>
      <span className="block truncate text-sub text-nc-text-4" title={note}>
        {note}
      </span>
    </>
  );
  return href ? (
    <Link
      href={href}
      className="block min-w-0 transition-colors hover:bg-nc-inset"
      aria-label={`${label}：${value === null ? "不可用" : `${value}${unit ?? ""}`}。${note}`}
      title={title}
    >
      {body}
    </Link>
  ) : (
    <div className="min-w-0" title={title}>
      {body}
    </div>
  );
}

/** Plain-text summary: only concatenates existing fields, never fills gaps.
 *  Screen readers and tests read it; the visual layout already shows the same
 *  facts in the ribbon and cards, so it is not repeated on screen. */
function todayConclusion(input: {
  date: string | null;
  dateStatus: string;
  stopRisks: number | null;
  candidates: number;
  historical: number;
  plans: number;
  dueSoon: number;
  mode: string;
  paperAccounts: number | null;
}) {
  const parts = [
    input.date
      ? `数据 ${input.date.slice(5)} ${input.dateStatus}`
      : "数据基准日未知",
    ...(input.stopRisks === null
      ? []
      : [
          input.stopRisks > 0
            ? `止损预警 ${input.stopRisks} 只`
            : "持仓无止损预警",
        ]),
    `候选 ${input.candidates} 个${input.historical > 0 ? `（历史只读 ${input.historical} 条）` : ""}`,
    `计划 ${input.plans} 笔${input.dueSoon > 0 ? `（${input.dueSoon} 笔即将到期）` : ""}`,
    input.mode,
    ...(input.paperAccounts === null
      ? []
      : [`本地模拟盘 ${input.paperAccounts} 个`]),
  ];
  return parts.join("｜");
}
export function TodayWorkspace() {
  const search = useSearchParams();
  const rawTab = search.get("tab");
  const tab: TodayTab =
    rawTab === "overview" || rawTab === "intraday" || rawTab === "pipeline"
      ? rawTab
      : "today";
  return (
    <div className="space-y-4 [&_p]:my-0!">
      <nav aria-label="今日交易标签页" className="flex justify-end">
        <Button
          asChild
          size="sm"
          variant={tab === "pipeline" ? "default" : "outline"}
        >
          <Link
            href="/?tab=pipeline"
            aria-current={tab === "pipeline" ? "page" : undefined}
          >
            策略运行台
          </Link>
        </Button>
      </nav>
      {tab === "overview" ? (
        <>
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-nc-border-soft pb-2">
            <h1 className="m-0 text-[length:var(--nc-font-size-page)] leading-[var(--nc-line-height-page)] font-semibold whitespace-nowrap text-nc-text">
              大盘总览
            </h1>
          </header>
          <Overview />
        </>
      ) : tab === "pipeline" ? (
        <>
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-nc-border-soft pb-2">
            <h1 className="m-0 text-[length:var(--nc-font-size-page)] leading-[var(--nc-line-height-page)] font-semibold whitespace-nowrap text-nc-text">
              策略运行台
            </h1>
          </header>
          <PipelineConsole />
        </>
      ) : tab === "intraday" ? (
        <>
          <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-nc-border-soft pb-2">
            <h1 className="m-0 text-[length:var(--nc-font-size-page)] leading-[var(--nc-line-height-page)] font-semibold whitespace-nowrap text-nc-text">
              盘中记录
            </h1>
          </header>
          <Intraday />
        </>
      ) : (
        <>
          <DailyDecision />
          <RecentDiagnoseArchives />
        </>
      )}
    </div>
  );
}

function RecentDiagnoseArchives() {
  const [expanded, setExpanded] = useState(false);
  const archives = api.strategyLabDiagnoseArchives.useQuery(
    { page: 1, pageSize: 5 },
    { enabled: expanded },
  );
  return (
    <section className="rounded-lg border border-nc-border bg-nc-card p-3">
      <h2 className="m-0 text-base">
        <Button
          type="button"
          variant="plain"
          className="w-full justify-between"
          aria-expanded={expanded}
          aria-controls="today-diagnose-archives"
          onClick={() => setExpanded(!expanded)}
        >
          最近诊断归档{" "}
          <span aria-hidden="true">{expanded ? "收起" : "展开"}</span>
        </Button>
      </h2>
      <div
        id="today-diagnose-archives"
        hidden={!expanded}
        className="space-y-2 px-3 py-2 text-sm"
      >
        {expanded && archives.isPending && (
          <p role="status">正在读取诊断归档…</p>
        )}
        {expanded && archives.isError && (
          <p role="alert" className="text-nc-warn">
            读取诊断归档失败：{archives.error.message}
          </p>
        )}
        {expanded && archives.data?.length === 0 && (
          <p className="text-nc-text-3">暂无诊断归档。</p>
        )}
        {expanded && !!archives.data?.length && (
          <ul className="space-y-1">
            {archives.data.map((archive) => (
              <li
                key={archive.id}
                className="flex flex-wrap items-baseline gap-x-2"
              >
                <Link
                  className="underline"
                  href={`/lab/backtest?archive=${encodeURIComponent(archive.id)}`}
                >
                  {archive.title}
                </Link>
                <span className="text-sub text-nc-text-3">
                  {archive.generatedAt}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function DailyDecision() {
  const visible = useScreenVisible();
  const { data: names } = useSecurityNames();
  const [filter, setFilter] = useState<MarketFilter>({
    market: "all",
    page: 0,
  });
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [plan, setPlan] = useState<{
    row: WorkspaceCandidate;
    key: string;
  } | null>(null);
  const [confirmation, setConfirmation] =
    useState<PlanSavedConfirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const [methodFilter, setMethodFilter] = useState<string>("all");
  const query = api.todayWorkspace.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const d = query.data;
  // Active local simulated accounts replace the retired fixed paper accounts;
  // the foreground read above already refreshes the same query cache.
  const simAccounts = api.simAccountsList.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const scanCloseDate = d?.readiness.equity.expectedDate ?? null;
  // A new reference close date starts a fresh candidate list at page 0; the
  // old deep page cannot be reused against the new snapshot.
  useEffect(() => {
    setFilter((current) =>
      current.page === 0 ? current : { ...current, page: 0 },
    );
  }, [scanCloseDate]);
  const useTodayBatch = isTodayBatch(filter.market, filter.page);
  // The filtered key keeps the today summary's 30s cadence only while it is on
  // screen and enabled; a hidden panel stops polling.
  const filteredEnabled = visible && !useTodayBatch && d !== undefined;
  const candidates = api.workspaceCandidates.useQuery(
    {
      page: filter.page,
      market: filter.market === "all" ? undefined : filter.market,
      scanCloseDate,
    },
    {
      enabled: filteredEnabled,
      refetchInterval: filteredEnabled ? 30000 : false,
    },
  );
  const summaryStale = Boolean(query.error) && d !== undefined;
  // A close-date rollover belongs to the key: old and new candidates can never
  // share an accumulated page buffer.
  const resetKey = JSON.stringify([filter.market, refreshNonce, scanCloseDate]);
  const currentRows = useTodayBatch
    ? d?.candidates.items
    : candidates.isSuccess && !candidates.isPlaceholderData
      ? candidates.data?.items
      : undefined;
  const currentTotal = useTodayBatch
    ? d?.candidates.total
    : candidates.isSuccess && !candidates.isPlaceholderData
      ? candidates.data?.total
      : undefined;
  const candidateTotal = !useTodayBatch
    ? (candidates.data?.total ?? d?.candidates.total)
    : d?.candidates.total;
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: filter.page,
    items: currentRows,
    total: currentTotal,
    getKey: (row) => row.key,
    isSuccess: useTodayBatch
      ? !summaryStale
      : candidates.isSuccess && !candidates.isPlaceholderData,
    snapshotKey: `${scanCloseDate ?? ""}:${candidateTotal ?? ""}`,
    onSnapshotDrift: () =>
      setFilter((current) =>
        current.page === 0 ? current : { ...current, page: 0 },
      ),
  });
  const view = d
    ? candidateView({
        market: filter.market,
        page: filter.page,
        all: d.candidates,
        filtered: candidates.data,
        fetching: candidates.isFetching,
        failure: candidates.error?.message ?? null,
        allStale: summaryStale,
        close: d.closeScan,
      })
    : null;
  // A stale summary or a failed candidate refresh cannot open new plans: the
  // reference read behind the shown rows is no longer the latest one. An
  // already-open form keeps its draft; only new plans are paused.
  const planningPaused = summaryStale || Boolean(view?.warning);
  if (query.error && !d)
    return (
      <StateBanner
        state="error"
        title="今日工作区读取失败"
        action={{ label: "重试", onClick: () => void query.refetch() }}
      >
        {query.error.message}
      </StateBanner>
    );
  if (!d || !view)
    return <StateBanner state="info" title="正在读取今日决策…" hideIcon />;
  const risks =
    d.holdings?.filter((h) => h.stop !== null && h.price <= h.stop) ?? [];
  const close = d.closeScan;
  const main = dailyMainAction({
    risks: risks.length,
    equityReady: d.readiness.equity.ready,
    cryptoReady: d.readiness.crypto.ready,
    candidates: d.candidates.total,
  });
  // The refresh action belongs to the query actually shown for this key.
  const activeQuery = useTodayBatch ? query : candidates;
  const readLabel = activeQuery.dataUpdatedAt
    ? new Date(activeQuery.dataUpdatedAt).toLocaleString("zh-CN")
    : "尚未成功读取";
  const readTime = activeQuery.dataUpdatedAt
    ? new Date(activeQuery.dataUpdatedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;
  const loaded = batches.rows.length > 0 ? batches.rows : (view.rows ?? []);
  const historicalRows = loaded.filter((row) => row.scan?.hasHistorical).length;
  const candidateHistorical = d.candidates.items.filter(
    (row) => row.scan?.hasHistorical,
  ).length;
  const date = d.readiness.equity.expectedDate;
  const dateStatus =
    date === null
      ? "基准日未知"
      : close.phase === "complete"
        ? "收盘已核验"
        : "等待收盘";
  const stopRisks = d.holdings === null ? null : risks.length;
  const modeValue =
    d.mode === "live"
      ? "正式提醒"
      : d.mode === "shadow"
        ? "观察模式"
        : "已关闭";
  const modeNote =
    d.mode === "live"
      ? `${alertModeLabel("live")}（已开启推送）`
      : d.mode === "shadow"
        ? alertModeLabel("shadow")
        : "提醒已关闭，不推送";
  const modeHint =
    d.mode === "live"
      ? "已开启推送"
      : d.mode === "shadow"
        ? "只记录不推送"
        : "不推送";
  const activeSimAccounts =
    simAccounts.data?.filter((account) => account.status === "active") ?? null;
  const simCount = activeSimAccounts ? activeSimAccounts.length : null;
  const simNote = simAccounts.error
    ? "读取失败"
    : activeSimAccounts === null
      ? "读取中"
      : activeSimAccounts.length === 0
        ? "尚无模拟账户"
        : activeSimAccounts.map((account) => account.name).join("、");
  const conclusion = todayConclusion({
    date,
    dateStatus,
    stopRisks,
    candidates: d.candidates.total,
    historical: candidateHistorical,
    plans: d.openPlans.total,
    dueSoon: d.openPlans.dueSoon,
    mode: modeValue,
    paperAccounts: simCount,
  });
  const readinessOf = (market: "cn-equity" | "crypto") =>
    market === "crypto" ? d.readiness.crypto : d.readiness.equity;
  // Readiness and capital gaps are one compact row, not four stacked cards.
  const issues = (["cn-equity", "crypto"] as const).flatMap((market) => {
    const label = market === "crypto" ? "数字货币" : "A 股";
    const found: string[] = [];
    if (!readinessOf(market).ready) found.push(`${label}数据未就绪`);
    if (d.capital[market] <= 0) found.push(`${label}资金为 0`);
    return found;
  });
  const methodology = [
    {
      label: "页面范围",
      detail:
        "一屏看清数据就绪、持仓止损、可计划候选与提醒模式；提醒与本地模拟记账，真实交易由用户操作。",
    },
    {
      label: "明日计划的来源",
      detail: `收盘扫描与观察模式候选，逐条标明观察时点；历史候选需核对行情，不是当次推荐。数字货币按下一完成周期。当前基准交易日 ${close.date ?? "待交易日历"}，收盘扫描${closeScanLabel[close.phase]}。`,
    },
    {
      label: "数量与滑点",
      detail:
        "数量沿用策略与本地模拟盘的仓位及费用假设；滑点影响以冻结研究口径和实际成交核对，不保证计划价成交。",
    },
    {
      label: "数据就绪",
      detail: `该日下载回执${d.readiness.equity.receipt ? "已就绪" : "未就绪"}，已启用 A 股策略 ${close.strategies} 条。就绪状态读取本地回执与官方归档索引，不自动回填。`,
    },
    {
      label: "止损单",
      detail:
        "按已完成收盘计算下一周期保护；挂单与退出由用户在券商操作，应用不核实券商是否已挂单。",
    },
    {
      label: "提醒与本地模拟盘",
      detail:
        "观察模式只记录不推送，正式提醒需要已启用的订阅；本地模拟盘只记录模拟成交与权益，不连接真实券商。",
    },
  ] satisfies readonly MethodologyItem[];
  const plannableSources = (row: WorkspaceCandidate) =>
    row.sources.filter((source) => source.scanFreshness !== "stale");
  const planSource = plan?.row.sources.find((s) => s.key === plan.key) ?? null;
  // Count each method family once per row so the filter reflects candidates,
  // not the number of strategy sources behind them.
  const methodCounts = new Map<string, { label: string; count: number }>();
  for (const row of batches.rows) {
    const families = new Map(
      row.sources.map((source) => {
        const info = strategyMethodInfo(source.strategyId);
        return [info.family, info] as const;
      }),
    );
    for (const [family, info] of families) {
      const entry = methodCounts.get(family);
      if (entry) entry.count += 1;
      else methodCounts.set(family, { label: info.label, count: 1 });
    }
  }
  const methodOptions = [...methodCounts.entries()].map(([family, value]) => ({
    family,
    ...value,
  }));
  const activeMethodFilter =
    methodFilter !== "all" &&
    methodOptions.some((option) => option.family === methodFilter)
      ? methodFilter
      : "all";
  const methodRows =
    activeMethodFilter === "all"
      ? batches.rows
      : batches.rows.filter((row) =>
          row.sources.some(
            (source) =>
              strategyMethodInfo(source.strategyId).family ===
              activeMethodFilter,
          ),
        );
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-nc-border-soft pb-2">
        <h1 className="m-0 text-[length:var(--nc-font-size-page)] leading-[var(--nc-line-height-page)] font-semibold whitespace-nowrap text-nc-text">
          A 股全天候作战室
        </h1>
        <span className="tabular whitespace-nowrap text-sub text-nc-text-4">
          截至 {new Date(d.now).toLocaleString("zh-CN")}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span
            className="nc-status-chip"
            data-state={
              d.mode === "live" ? "ok" : d.mode === "shadow" ? "idle" : "warn"
            }
            title={modeNote}
          >
            <i aria-hidden="true" />
            {modeValue}
          </span>
          <MethodologyPopover items={methodology} />
          <Button asChild size="sm">
            <Link href={main.href}>{main.text}</Link>
          </Button>
        </div>
      </header>
      <div className="nc-ribbon" role="group" aria-label="今日交易摘要">
        <RibbonCell
          label="数据基准日"
          value={date}
          note={dateStatus}
          href="/?tab=overview"
          tone={dateStatus === "收盘已核验" ? undefined : "warn"}
          title="交易日历给出的应到交易日；核验以收盘扫描记录为准"
        />
        <RibbonCell
          label="持仓止损预警"
          value={stopRisks}
          unit="只"
          note={
            d.holdings === null
              ? "持仓尚未核对"
              : risks.length > 0
                ? `持仓 ${d.holdings.length} 只 · 已跌破`
                : `持仓 ${d.holdings.length} 只 · 无预警`
          }
          href="/accounts"
          tone={stopRisks !== null && stopRisks > 0 ? "warn" : undefined}
          title="按已完成收盘价与已核对止损价比较"
        />
        <RibbonCell
          label="今日可计划候选"
          value={d.candidates.total}
          unit="个"
          note={
            candidateHistorical > 0
              ? `含历史只读 ${candidateHistorical} 条`
              : "无历史只读"
          }
          title="候选总数；历史只读条目不能直接新建计划"
        />
        <RibbonCell
          label="进行中计划"
          value={d.openPlans.total}
          unit="笔"
          note={`24h 到期 ${d.openPlans.dueSoon} 笔`}
          title={`未完成计划；期限待核验 ${d.openPlans.unverified} 笔，仅影响提示，不自动关闭计划`}
        />
        <RibbonCell
          label="提醒模式"
          value={modeValue}
          note={modeHint}
          href="/system/notifications"
          tone={d.mode === "off" ? "warn" : undefined}
          title="观察模式只记录不推送；正式提醒需要已启用的订阅"
        />
        <RibbonCell
          label="本地模拟盘"
          value={simCount}
          unit="个"
          note={simNote}
          href="/accounts?tab=paper"
          tone={simAccounts.error ? "warn" : undefined}
          title={
            simAccounts.error
              ? "模拟账户读取失败，点击核对"
              : "仅统计活跃的本地模拟账户；只记录模拟成交与权益，不连接真实券商"
          }
        />
      </div>
      <p className="sr-only" data-testid="today-conclusion" role="status">
        {conclusion}
      </p>
      {summaryStale && (
        <StateBanner
          state="stale"
          title="今日工作区刷新失败"
          asOf={`最近成功读取 ${new Date(query.dataUpdatedAt).toLocaleString("zh-CN")}`}
          action={{ label: "重试", onClick: () => void query.refetch() }}
        >
          {query.error?.message}
          。以下为最近一次成功读取的今日快照；已暂停从此快照创建新计划。
        </StateBanner>
      )}
      {issues.length > 0 && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-nc-warn-edge bg-nc-inset px-3 py-1.5 text-sm text-nc-warn"
        >
          <strong className="font-medium">数据与资金待处理</strong>
          <span>{issues.join(" · ")}；候选可能缺失，计划数量无法计算。</span>
          <Link href="/system" className="underline">
            前往系统页补齐
          </Link>
        </div>
      )}
      <nav
        aria-label="作战室面板"
        className="flex flex-wrap gap-x-4 gap-y-1 text-sub"
      >
        <a href="#market-conditions" className="text-nc-accent hover:underline">
          市场温度与行业轮动
        </a>
        <a href="#workspace-news" className="text-nc-accent hover:underline">
          精准快讯
        </a>
        <a href="#rebalance-tickets" className="text-nc-accent hover:underline">
          次日调仓计划单
        </a>
      </nav>
      <div className="nc-cockpit-grid">
        <div className="min-w-0 space-y-4">
          <Panel
            id="tomorrow"
            aria-label="明日计划"
            title="明日交易候选"
            actions={
              <>
                <Segmented
                  label="候选市场"
                  value={filter.market}
                  onChange={(market) =>
                    setFilter((current) => selectMarket(current, market))
                  }
                  options={todayMarketOptions}
                />
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="刷新候选"
                  title="刷新候选"
                  disabled={activeQuery.isFetching}
                  onClick={() => {
                    setFilter((current) => ({ ...current, page: 0 }));
                    setRefreshNonce((n) => n + 1);
                    void (filter.market === "all"
                      ? query.refetch()
                      : candidates.refetch());
                  }}
                >
                  刷新
                </Button>
                <span
                  className="tabular whitespace-nowrap text-sub text-nc-text-4"
                  title={`当前候选最近成功读取：${readLabel}`}
                >
                  {activeQuery.isFetching ? "刷新中…" : (readTime ?? "—")}
                </span>
              </>
            }
          >
            <div className="space-y-2">
              <PlanSavedNotice confirmation={confirmation} />
              {view.warning && (
                <StateBanner
                  state="stale"
                  title="候选刷新失败"
                  asOf={`最近成功读取 ${readLabel}`}
                  action={{
                    label: "重试",
                    onClick: () => void candidates.refetch(),
                  }}
                >
                  {view.warning}
                  。以下为最近一次成功读取的候选；已暂停从该读数创建计划。
                </StateBanner>
              )}
              {historicalRows > 0 && (
                <p className="text-sm text-nc-warn" role="status">
                  {close.phase === "complete"
                    ? "含历史来源，不是当次推荐。"
                    : "收盘扫描未完成，以下为历史候选，不是当次推荐。"}
                </p>
              )}
              {batches.rows.length > 0 && (
                <div
                  aria-label="选股方法筛选"
                  role="group"
                  className="flex flex-wrap items-center gap-1.5 rounded-lg border border-nc-border-soft bg-nc-inset px-2 py-1.5"
                >
                  <span className="text-xs text-nc-text-3">选股方法</span>
                  {[
                    {
                      family: "all",
                      label: "全部方法",
                      count: batches.rows.length,
                    },
                    ...methodOptions,
                  ].map((option) => {
                    const active = activeMethodFilter === option.family;
                    return (
                      <button
                        key={option.family}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setMethodFilter(option.family)}
                        className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                          active
                            ? "border-nc-accent bg-nc-card font-medium text-nc-text"
                            : "border-nc-border-soft text-nc-text-3 hover:bg-nc-card"
                        }`}
                      >
                        {option.label} ({option.count})
                      </button>
                    );
                  })}
                  <span className="ml-auto text-[11px] text-nc-text-4">
                    点击标的右侧方法标签或下方筛选可按选股方法（双突破 /
                    缠论三买 / 历史低位 / 公式等）查看入选原因
                  </span>
                </div>
              )}
              {batches.rows.length === 0 && view.rows === undefined ? (
                view.error ? (
                  <StateBanner
                    state="error"
                    title="候选读取失败"
                    action={{
                      label: "重试",
                      onClick: () => void candidates.refetch(),
                    }}
                  >
                    {view.error}
                  </StateBanner>
                ) : (
                  <StateBanner
                    state="info"
                    title={PENDING_CANDIDATE_MESSAGE}
                    hideIcon
                  />
                )
              ) : (
                <CandidateTable
                  data={methodRows}
                  securityNames={names}
                  total={
                    activeMethodFilter === "all"
                      ? batches.rows.length > 0
                        ? batches.total
                        : (view.total ?? 0)
                      : methodRows.length
                  }
                  infiniteScroll={{
                    hasMore: batches.hasMore,
                    loadingMore: filter.page > 0 && candidates.isFetching,
                    onLoadMore: () =>
                      setFilter((current) => ({
                        ...current,
                        page: current.page + 1,
                      })),
                  }}
                  loading={batches.rows.length === 0 && view.loading}
                  error={
                    batches.rows.length > 0
                      ? (view.error ?? undefined)
                      : undefined
                  }
                  onRetry={() => void candidates.refetch()}
                  onPlan={
                    planningPaused
                      ? undefined
                      : (row) => {
                          const source =
                            row.sources.find(
                              (s) => s.scanFreshness === "current",
                            ) ?? plannableSources(row)[0];
                          if (source) {
                            setConfirmation(null);
                            setSaving(false);
                            setPlan({ row, key: source.key });
                          }
                        }
                  }
                  canPlan={
                    planningPaused
                      ? undefined
                      : (row) => plannableSources(row).length > 0
                  }
                  onMethodSelect={(family) =>
                    setMethodFilter((cur) => (cur === family ? "all" : family))
                  }
                  emptyMessage={view.emptyMessage ?? undefined}
                />
              )}
            </div>
          </Panel>
          <Panel
            title="进行中交易计划"
            aria-label="未完成交易计划"
            actions={
              <>
                <span
                  className="nc-status-chip"
                  data-state="ok"
                  title="有效且未到期"
                >
                  有效 {d.openPlans.valid}
                </span>
                <span
                  className="nc-status-chip"
                  data-state={d.openPlans.dueSoon > 0 ? "warn" : "idle"}
                >
                  24h到期 {d.openPlans.dueSoon}
                </span>
                <span
                  className="nc-status-chip"
                  data-state={d.openPlans.expired > 0 ? "bad" : "idle"}
                >
                  已到期 {d.openPlans.expired}
                </span>
                <Link
                  className="text-sub whitespace-nowrap underline"
                  href="/accounts/alerts"
                >
                  台账全部 →
                </Link>
              </>
            }
          >
            <DataTable
              label="未完成交易计划"
              data={d.openPlans.items}
              rowCount={d.openPlans.total}
              pagination={{ pageIndex: 0, pageSize: 20 }}
              sorting={[]}
              onPaginationChange={() => {}}
              onSortingChange={() => {}}
              showPagination={false}
              getRowId={(p) => p.id}
              columns={[
                {
                  id: "symbol",
                  header: "标的 / 策略",
                  cell: ({ row: { original: p } }) => (
                    <span
                      className="block max-w-[16rem] truncate"
                      title={`${p.symbol} · ${p.strategyId} v${p.strategyVersion}`}
                    >
                      {p.symbol} · {p.strategyId} v{p.strategyVersion}
                    </span>
                  ),
                },
                {
                  id: "entry",
                  header: () => (
                    <span className="block text-right">入场 / 数量</span>
                  ),
                  cell: ({ row: { original: p } }) => (
                    <span className="block text-right tabular-nums">
                      {formatNumber(p.entry)} /{" "}
                      {formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}
                    </span>
                  ),
                },
                {
                  id: "stop",
                  header: () => (
                    <span className="block text-right">止损 / 目标</span>
                  ),
                  cell: ({ row: { original: p } }) => (
                    <span className="block text-right tabular-nums">
                      {formatNumber(p.stop)} / {formatNumber(p.target)}
                    </span>
                  ),
                },
                {
                  id: "expiry",
                  header: "有效至 / 状态",
                  cell: ({ row: { original: p } }) => {
                    const at = p.expiresAt
                      ? new Date(p.expiresAt).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        })
                      : "";
                    const state =
                      p.expiryState === "expired"
                        ? "bad"
                        : p.expiryState === "due-soon" ||
                            p.expiryState === "unverified"
                          ? "warn"
                          : "idle";
                    const label =
                      p.expiryState === "expired"
                        ? "已到期"
                        : p.expiryState === "due-soon"
                          ? "24h到期"
                          : p.expiryState === "unverified"
                            ? "待核验"
                            : "有效";
                    const title =
                      p.expiryState === "expired"
                        ? "已过有效时间但计划仍未完成"
                        : p.expiryState === "due-soon"
                          ? "24 小时内到期"
                          : p.expiryState === "unverified"
                            ? "期限待核验，只影响提示"
                            : "在有效期内";
                    return (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span
                          className="nc-status-chip"
                          data-state={state}
                          title={title}
                        >
                          <i aria-hidden="true" />
                          {label}
                        </span>
                        {at && (
                          <span className="tabular text-sub text-nc-text-4">
                            {at}
                          </span>
                        )}
                      </span>
                    );
                  },
                },
                {
                  id: "policy",
                  header: "仓位依据",
                  cell: ({ row: { original: p } }) => {
                    const validated = p.sizingAudit?.validated;
                    const deviated =
                      Boolean(p.sizingAudit?.overridden) ||
                      (p.protection?.version === "plan-protection-1" &&
                        !p.protection.matchesStrategy);
                    const missingExit = p.protection?.version === "unavailable";
                    const title =
                      [
                        deviated ? "已确认偏离策略参数" : null,
                        missingExit ? "缺完整退出规格" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || undefined;
                    return (
                      <span
                        className={validated ? "text-nc-ok" : "text-nc-warn"}
                        title={title}
                      >
                        {validated ? "已验证" : "研究中"}
                      </span>
                    );
                  },
                },
                {
                  id: "detail",
                  header: "核对",
                  cell: ({ row: { original: p } }) => (
                    <Link
                      className="underline"
                      href={`/accounts/alerts?plan=${encodeURIComponent(p.id)}`}
                    >
                      详情
                    </Link>
                  ),
                },
              ]}
              emptyMessage="尚无未完成交易计划。可直接从上方候选加入。"
            />
          </Panel>
        </div>
        <div className="min-w-0 space-y-4">
          <Panel id="holding-risk" title="持仓止损监控" meta="完成 bar 价格">
            <AccountRiskLinks />
            {d.holdings === null ? (
              <p className="text-sm text-nc-text-3">尚未核对持仓，风险未知。</p>
            ) : d.holdings.length === 0 ? (
              <p className="text-sm text-nc-text-3">最近核对无持仓。</p>
            ) : (
              <div className="divide-y divide-nc-border-soft">
                {d.holdings.map((h) => (
                  <div
                    key={`${h.market}:${h.account}:${h.symbol}`}
                    className="space-y-1 py-2"
                    title={`${h.bar} · 成本${h.cost === null ? "未核对" : "已核对"}；R=(现价−成本)/(成本−止损)`}
                  >
                    <Link
                      className="font-medium underline"
                      href={`/accounts?position=${encodeURIComponent(h.market === "cn-equity" ? `local:${h.symbol}` : `crypto:${h.account}`)}`}
                    >
                      {h.symbol}
                    </Link>
                    <RiskDistanceBar
                      price={h.price}
                      stop={h.stop}
                      cost={h.cost}
                      compact
                    />
                  </div>
                ))}
              </div>
            )}
            {d.stopTasks.length > 0 && (
              <section
                aria-label="设置或调整止损单"
                className="mt-3 space-y-1 border-t border-nc-border-soft pt-2"
              >
                <p className="text-sub font-medium text-nc-warn">
                  待调整止损 {d.stopTasks.length}
                </p>
                {d.stopTasks.map((t) => {
                  const due = t.dueAt
                    ? new Date(t.dueAt).toLocaleString("zh-CN", {
                        timeZone:
                          t.market === "cn-equity" ? "Asia/Shanghai" : "UTC",
                      })
                    : (t.dueDate ?? "待完整行情");
                  return (
                    <p
                      key={t.key}
                      className="truncate text-sm"
                      title={`${t.reason} · ${due} · ${t.strategyId} v${t.version} · 来源计划 ${t.sourcePlanId}`}
                    >
                      {t.symbol} · {formatNumber(t.oldStop)} →{" "}
                      {formatNumber(t.newStop)} ·{" "}
                      {
                        {
                          set: "设置止损",
                          adjust: "调整止损",
                          "time-exit": "时间退出",
                          "rule-exit": "策略退出",
                          "target-exit": "目标退出",
                          "stop-exit": "保护价触及",
                          "needs-review": "需要核验",
                        }[t.status]
                      }
                      <span className="sr-only">
                        {" "}
                        · 来源计划 {t.sourcePlanId} · {t.strategyId} v
                        {t.version} · {due} · {t.reason}
                      </span>
                    </p>
                  );
                })}
              </section>
            )}
          </Panel>
        </div>
      </div>
      {/* Mount supplementary reads after the initial workspace response. */}
      <MarketConditions />
      <WorkspaceNews
        holdings={
          d.holdings
            ?.filter(
              (holding) =>
                holding.market === "cn-equity" && holding.quantity > 0,
            )
            .map((holding) => holding.symbol) ?? null
        }
        candidates={d.candidates.items
          .filter((candidate) => candidate.market === "cn-equity")
          .map((candidate) => candidate.symbol)}
        candidateTotal={d.candidates.total}
        names={names}
      />
      <RebalanceTicketPanel decisionDate={date} />
      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setPlan(null);
        }}
      >
        <DialogContent className="left-auto! right-4! top-4! translate-x-0! translate-y-0! lg:max-w-xl">
          <DialogTitle>创建交易计划 · {plan?.row.symbol}</DialogTitle>
          <DialogDescription>
            核对所选策略及止损保护价；保存后可在本页查看未完成计划。
          </DialogDescription>
          {plan && plannableSources(plan.row).length > 1 && (
            <LedgerSelect
              label="计划来源策略"
              value={plan.key}
              onChange={(key) => setPlan({ ...plan, key })}
              options={plannableSources(plan.row).map((s) => ({
                value: s.key,
                label: `${s.strategyId} v${s.version} · ${s.sleeve}`,
              }))}
            />
          )}
          {planSource && (
            <CandidatePlan
              key={planSource.key}
              candidate={planSource}
              inline
              onPendingChange={setSaving}
              onSaved={(saved) => {
                // Keep the form mounted so the saved plan can be executed into
                // a compatible local simulated account without another trip.
                setSaving(false);
                setConfirmation(saved);
              }}
              onClose={() => setPlan(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
