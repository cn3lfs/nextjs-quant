"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { api } from "~/trpc/react";
import {
  formatNumber,
  formatPercent,
} from "trading-strategy-core/format-number";
import { Panel, Segmented, StateBanner, WorkspaceHeader } from "../panels";
import { Button } from "../ui/button";
import { alertModeLabel } from "~/lib/common/ui-glossary";
import { CandidateTable, type WorkspaceCandidate } from "./candidate-table";
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
import { useScreenVisible } from "../workbench/use-task-visible";
import { PaperFacts } from "../portfolio/paper-accounts-panel";
import { AccountRiskLinks } from "../portfolio/account-risk-links";
import { TodayIntel } from "../news/today-intel";
import { PaperShadowPrompt } from "../research/paper-shadow-prompt";
import { CryptoRiskNotes } from "../portfolio/crypto-risk-notes";
import { PaperForwardStatus } from "../portfolio/paper-forward-status";
import type { CloseScanPhase } from "~/lib/market/close-scan-window";
const Overview = dynamic(() =>
  import("./today-overview").then((m) => m.TodayOverview),
);
const Intraday = dynamic(() =>
  import("../workbench/route-panels").then((m) => m.IntradayPanel),
);
const closeScanLabel: Record<CloseScanPhase, string> = {
  "unknown-date": "基准交易日未知",
  waiting: "等待收盘",
  unconfirmed: "等待或未确认",
  running: "扫描中",
  missed: "已错过（不补跑）",
  complete: "流程已结束",
};

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

/** Plain-text summary: only concatenates existing fields, never fills gaps. */
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
  const tab = search.get("tab") ?? "today";
  return (
    <div className="space-y-4 [&_p]:my-0!">
      <Segmented
        label="今日视图"
        value={tab}
        onChange={(v) =>
          window.history.pushState(null, "", v === "today" ? "/" : `/?tab=${v}`)
        }
        options={[
          { value: "today", label: "今日决策" },
          { value: "overview", label: "市场与数据总览" },
          { value: "intraday", label: "盘中预选历史" },
        ]}
      />
      {tab === "overview" ? (
        <Overview />
      ) : tab === "intraday" ? (
        <Intraday />
      ) : (
        <DailyDecision />
      )}
    </div>
  );
}
function DailyDecision() {
  const visible = useScreenVisible();
  const [filter, setFilter] = useState<MarketFilter>({
    market: "all",
    page: 0,
  });
  const [plan, setPlan] = useState<{
    row: WorkspaceCandidate;
    key: string;
  } | null>(null);
  const [confirmation, setConfirmation] =
    useState<PlanSavedConfirmation | null>(null);
  const [saving, setSaving] = useState(false);
  const query = api.todayWorkspace.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const d = query.data;
  // Shares the cache key with the paper-forward panel; one read serves both.
  const paper = api.paperAccounts.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
  });
  const scanCloseDate = d?.readiness.equity.expectedDate ?? null;
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
  const loaded = view.rows ?? [];
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
  // One of the three ribbon statuses, with the scan phase as a detail instead
  // of a fourth label (a missed scan is still "等待收盘" for the reader).
  const dateDetail =
    dateStatus === "基准日未知"
      ? "基准日未知"
      : close.phase === "complete"
        ? "收盘已核验"
        : `等待收盘${closeScanLabel[close.phase] === "等待收盘" ? "" : `（${closeScanLabel[close.phase]}）`}`;
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
  const paperCount = paper.data ? paper.data.length : null;
  const paperNote = paper.error
    ? "模拟盘读取失败，点击核对"
    : paper.data === undefined
      ? "正在读取模拟盘"
      : paper.data.length === 0
        ? "尚无本地模拟盘账号"
        : paper.data[0]
          ? `${paper.data[0].id}：${paper.data[0].currentAssessment.recommendation}`
          : "推进状态未记录";
  const conclusion = todayConclusion({
    date,
    dateStatus,
    stopRisks,
    candidates: d.candidates.total,
    historical: candidateHistorical,
    plans: d.openPlans.total,
    dueSoon: d.openPlans.dueSoon,
    mode: modeValue,
    paperAccounts: paperCount,
  });
  const plannableSources = (row: WorkspaceCandidate) =>
    row.sources.filter((source) => source.scanFreshness !== "stale");
  const planSource = plan?.row.sources.find((s) => s.key === plan.key) ?? null;
  return (
    <div className="space-y-4">
      <WorkspaceHeader
        eyebrow="今日交易"
        title="今日决策"
        scope="一屏看清数据就绪、持仓止损、可计划候选与提醒模式；提醒与本地模拟记账，真实交易由用户操作。"
        asOf={<>截至 {new Date(d.now).toLocaleString("zh-CN")}</>}
        status={
          <span
            className="nc-status-chip"
            data-state={
              d.mode === "live" ? "ok" : d.mode === "shadow" ? "idle" : "warn"
            }
          >
            <i aria-hidden="true" />
            {modeNote}
          </span>
        }
        primaryAction={
          <Button asChild>
            <Link href={main.href}>{main.text}</Link>
          </Button>
        }
      />
      <div className="nc-ribbon" role="group" aria-label="今日交易摘要">
        <RibbonCell
          label="数据基准日"
          value={date}
          note={`${dateDetail} · 下载回执${d.readiness.equity.receipt ? "已就绪" : "未就绪"}`}
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
                ? `持仓 ${d.holdings.length} 只，已跌破止损`
                : `持仓 ${d.holdings.length} 只，无跌破止损`
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
              ? `本页历史只读 ${candidateHistorical} 条`
              : "本页无历史只读"
          }
          title="候选总数；历史只读条目不能直接新建计划"
        />
        <RibbonCell
          label="进行中计划"
          value={d.openPlans.total}
          unit="笔"
          note={`24小时内到期 ${d.openPlans.dueSoon} 笔 · 期限待核验 ${d.openPlans.unverified} 笔`}
          title="未完成计划；到期与待核验只影响提示，不自动关闭计划"
        />
        <RibbonCell
          label="提醒模式"
          value={modeValue}
          note={modeNote}
          href="/system/notifications"
          tone={d.mode === "off" ? "warn" : undefined}
          title="观察模式只记录不推送；正式提醒需要已启用的订阅"
        />
        <RibbonCell
          label="本地模拟盘"
          value={paperCount}
          unit="个"
          note={paperNote}
          href="/accounts?tab=paper"
          tone={paper.error ? "warn" : undefined}
          title="只记录模拟成交与权益，不连接真实券商"
        />
      </div>
      <p
        className="text-sub text-nc-text-3"
        data-testid="today-conclusion"
        role="status"
      >
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
      {(
        [
          ["cn-equity", "A 股", d.readiness.equity.ready],
          ["crypto", "数字货币", d.readiness.crypto.ready],
        ] as const
      )
        .filter(([, , ready]) => !ready)
        .map(([market, label]) => (
          <StateBanner key={market} state="warn" title={`${label}数据未就绪`}>
            候选可能缺失或停留在历史来源；显示数量是候选，不是已保存计划。{" "}
            <Link href="/system" className="underline">
              前往系统页补齐
            </Link>
          </StateBanner>
        ))}
      {(["cn-equity", "crypto"] as const)
        .filter((market) => d.capital[market] <= 0)
        .map((market) => (
          <StateBanner
            key={market}
            state="warn"
            title={`${market === "crypto" ? "数字货币" : "A股"}资金为 0`}
          >
            无法计算交易计划数量。请在系统页配置市场资金及分仓份额。{" "}
            <Link href="/system" className="underline">
              配置分仓资金
            </Link>
          </StateBanner>
        ))}
      <PaperShadowPrompt />
      <PaperForwardStatus compact />
      <CryptoRiskNotes />
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          className="col-span-1!"
          title="市场状态"
          meta="提醒引擎的最近一次完成行情观察"
        >
          <div className="grid gap-3 lg:grid-cols-2">
            {d.regimes.map((r) => (
              <div key={r.symbol} className="rounded border p-3">
                <strong>{r.symbol}</strong>
                <p>
                  {r.value
                    ? `${{ up: "上升", down: "下降", mixed: "震荡" }[r.value.trend]} · 温度 ${formatNumber(r.value.temperature, 1)}`
                    : "尚无有效观察"}
                </p>
                {r.market === "cn-equity" && (
                  <p className="text-xs">
                    历史低位深度 {r.value?.low?.depth ?? "未知"} ·{" "}
                    {r.value?.low?.confidence ?? "待数据"}
                  </p>
                )}
                <p className="text-xs text-nc-text-3">
                  {r.value?.bar ?? "时点未记录"}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-nc-text-3">
            趋势=收盘/SMA20/SMA60；温度=近120根收盘分位，非完整市场温度。低位=5–10年价格分位与回撤；无财务佐证时仅价格依据。
          </p>
        </Panel>
        <Panel
          className="col-span-1!"
          title="分仓占用与目标"
          meta="占用来自最近核对；偏离阈值10个百分点"
        >
          <div className="space-y-2">
            {d.sleeves.map((s) => (
              <div
                key={`${s.market}:${s.id}`}
                className="flex flex-wrap justify-between gap-2 border-b pb-2 text-sm"
              >
                <span>
                  {s.market === "crypto" ? "币种" : "A股"} · {s.id}
                </span>
                <span className={s.drift ? "text-nc-warn" : ""}>
                  实际{" "}
                  {formatPercent(s.actual === null ? null : s.actual * 100)} /
                  目标 {formatPercent(s.share * 100)} · {formatNumber(s.value)}
                  {s.drift ? " · 偏离" : ""}
                  {!s.fresh ? " · 待更新核对" : ""}
                  {s.at !== null && (
                    <span className="block text-xs text-nc-text-3">
                      {s.snapshotBasis === "post-close"
                        ? "收盘后快照"
                        : "盘中快照"}{" "}
                      · {new Date(s.at).toLocaleString("zh-CN")}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      </div>
      <section className="rounded-lg border bg-nc-card p-4">
        <h2 className="mb-3 text-lg font-semibold text-nc-accent">
          今日模拟账户变化
        </h2>
        <PaperFacts today />
      </section>
      <section
        id="tomorrow"
        aria-label="明日计划"
        className="space-y-2 rounded-lg border bg-nc-card p-4"
      >
        <h2 className="text-lg font-semibold">明日计划</h2>
        <Segmented
          label="候选市场"
          value={filter.market}
          onChange={(market) =>
            setFilter((current) => selectMarket(current, market))
          }
          options={todayMarketOptions}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={activeQuery.isFetching}
            onClick={() => void activeQuery.refetch()}
          >
            刷新候选
          </Button>
          <span className="text-xs text-nc-text-3">
            {activeQuery.isFetching ? "刷新中… · " : ""}
            当前候选最近成功读取：{readLabel}
          </span>
        </div>
        <PlanSavedNotice confirmation={confirmation} />
        {view.warning && (
          <StateBanner
            state="stale"
            title="候选刷新失败"
            asOf={`最近成功读取 ${readLabel}`}
            action={{ label: "重试", onClick: () => void candidates.refetch() }}
          >
            {view.warning}
            。以下为最近一次成功读取的候选；已暂停从该读数创建计划。
          </StateBanner>
        )}
        <p className="text-xs text-nc-text-3">
          收盘扫描与观察模式候选，逐条标明观察时点；历史候选需核对行情。数字货币按下一完成周期。数量沿用策略与本地模拟盘的仓位及费用假设；滑点影响以冻结研究口径和实际成交核对，不保证计划价成交。
        </p>
        <p className="text-xs text-nc-text-3" role="status">
          基准交易日：{close.date ?? "待交易日历"} · 收盘扫描：
          {closeScanLabel[close.phase]}
          {close.calendarConfirmed ? "" : " · 下一交易日未确认"}
          {close.at !== null && (
            <> · 记录于 {new Date(close.at).toLocaleString("zh-CN")}</>
          )}{" "}
          · 该日下载回执：
          {d.readiness.equity.receipt ? "已就绪" : "未就绪"} · 已启用 A 股策略{" "}
          {close.strategies} 条
        </p>
        {historicalRows > 0 && (
          <p className="text-sm text-nc-warn">
            {close.phase === "complete"
              ? "以下含历史来源，不是当次推荐。"
              : "最近收盘扫描未完成，以下为历史候选，不是当次推荐。"}
          </p>
        )}
        {close.phase === "complete" &&
          !view.stale &&
          view.rows !== undefined &&
          view.total === 0 &&
          filter.market !== "crypto" && (
            <p className="text-xs text-nc-text-3">
              A股本地日线：{d.readiness.equity.localDate ?? "未知"} ·
              应到交易日：
              {close.date ?? "待日历"} · 回执：
              {d.readiness.equity.receipt ? "已就绪" : "未就绪"} · 数据缺口{" "}
              {d.gaps.length} 项{d.gaps.length ? "（见下方）" : ""}
              。该结论只表示扫描流程结束。
            </p>
          )}
        {view.rows === undefined ? (
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
            data={view.rows}
            total={view.total ?? 0}
            page={filter.page}
            onPage={(page) => setFilter((current) => ({ ...current, page }))}
            loading={view.loading}
            onRetry={() => void candidates.refetch()}
            onPlan={
              planningPaused
                ? undefined
                : (row) => {
                    const source =
                      row.sources.find((s) => s.scanFreshness === "current") ??
                      plannableSources(row)[0];
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
            emptyMessage={view.emptyMessage ?? undefined}
          />
        )}
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
                  setSaving(false);
                  setPlan(null);
                  setConfirmation(saved);
                }}
                onClose={() => setPlan(null)}
              />
            )}
          </DialogContent>
        </Dialog>
      </section>
      <section
        className="space-y-2 rounded-lg border bg-nc-card p-4"
        aria-label="未完成交易计划"
      >
        <h2 className="text-lg font-semibold">
          交易计划与到期状态 · {d.openPlans.total}
        </h2>
        <p className="text-xs text-nc-text-3">
          有效 {d.openPlans.valid} 笔（24小时内到期 {d.openPlans.dueSoon} 笔）·
          期限待核验 {d.openPlans.unverified} 笔 · 已到期仍为未完成{" "}
          {d.openPlans.expired} 笔 ·{" "}
          <Link href="/accounts/alerts" className="underline">
            在信号台账查看全部
          </Link>
        </p>
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
              cell: ({ row: { original: p } }) =>
                `${p.symbol} · ${p.strategyId} v${p.strategyVersion}`,
            },
            {
              id: "entry",
              header: "入场 / 数量",
              cell: ({ row: { original: p } }) =>
                `${formatNumber(p.entry)} / ${formatNumber(p.quantity, p.market === "crypto" ? 6 : 0)}`,
            },
            {
              id: "stop",
              header: "止损 / 目标",
              cell: ({ row: { original: p } }) =>
                `${formatNumber(p.stop)} / ${formatNumber(p.target)}`,
            },
            {
              id: "expiry",
              header: "有效至 / 状态",
              cell: ({ row: { original: p } }) => {
                if (p.expiryState === "unverified")
                  return <span className="text-nc-warn">期限待核验</span>;
                const at = p.expiresAt
                  ? new Date(p.expiresAt).toLocaleString("zh-CN")
                  : "";
                if (p.expiryState === "expired")
                  return (
                    <span className="text-nc-bad">
                      {at} · 已到期，计划仍未完成
                    </span>
                  );
                if (p.expiryState === "due-soon")
                  return (
                    <span className="text-nc-warn">{at} · 24小时内到期</span>
                  );
                return at;
              },
            },
            {
              id: "policy",
              header: "仓位 / 保护依据",
              cell: ({ row: { original: p } }) => (
                <span>
                  {p.sizingAudit?.validated
                    ? "通过研究验证"
                    : "研究中 / 未验证"}
                  {p.sizingAudit?.overridden ||
                  (p.protection?.version === "plan-protection-1" &&
                    !p.protection.matchesStrategy)
                    ? " · 已确认偏离策略参数"
                    : ""}
                  {p.protection?.version === "unavailable"
                    ? " · 缺完整退出规格"
                    : ""}
                </span>
              ),
            },
            {
              id: "journal",
              header: "计划理由 / 标签",
              cell: ({ row: { original: p } }) =>
                [p.rationale || "未记录", ...(p.tags ?? [])].join(" · "),
            },
            {
              id: "detail",
              header: "核对",
              cell: ({ row: { original: p } }) => (
                <Link
                  className="underline"
                  href={`/accounts/alerts?plan=${encodeURIComponent(p.id)}`}
                >
                  计划详情
                </Link>
              ),
            },
          ]}
          emptyMessage="尚无未完成交易计划。可直接从上方候选加入。"
        />
      </section>
      <section
        className="space-y-2 rounded-lg border bg-nc-card p-4"
        aria-label="设置或调整止损单"
      >
        <h2 className="text-lg font-semibold">设置 / 调整止损单</h2>
        <p className="text-xs text-nc-text-3">
          按已完成收盘计算下一周期保护；挂单与退出由用户在券商操作，应用不核实券商是否已挂单。
        </p>
        {d.stopTasks.length ? (
          d.stopTasks.map((t) => (
            <div key={t.key} className="border-b pb-2 text-sm">
              <strong>
                {t.symbol} · {t.account}
              </strong>{" "}
              · {formatNumber(t.oldStop)} → {formatNumber(t.newStop)} ·{" "}
              {
                {
                  set: "设置止损",
                  adjust: "调整止损",
                  "time-exit": "时间退出",
                  "rule-exit": "策略退出条件",
                  "target-exit": "目标退出",
                  "stop-exit": "保护价触及",
                  "needs-review": "需要核验",
                }[t.status]
              }
              <p>{t.reason}</p>
              <p className="text-xs text-nc-text-3">
                {t.dueAt
                  ? `${new Date(t.dueAt).toLocaleString("zh-CN", { timeZone: t.market === "cn-equity" ? "Asia/Shanghai" : "UTC" })} ${t.market === "cn-equity" ? "北京时间" : "UTC"}`
                  : (t.dueDate ?? "待完整行情")}{" "}
                · {t.strategyId} v{t.version} · 来源计划 {t.sourcePlanId}
              </p>
            </div>
          ))
        ) : (
          <p>当前没有已关联持仓的止损任务。</p>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          className="col-span-1!"
          title="已触发的提醒"
          meta="今日最新10条 · 观察模式与正式提醒"
        >
          <div className="max-h-40 space-y-2 overflow-auto">
            {d.triggered.items.length ? (
              d.triggered.items.map((e) => (
                <p key={e.key} className="text-sm">
                  <strong>
                    {alertModeLabel(e.mode)} · {e.symbol}
                  </strong>{" "}
                  · {e.reason}
                </p>
              ))
            ) : (
              <p>今日尚无提醒。</p>
            )}
            <Link className="text-sm underline" href="/accounts/alerts">
              完整历史与前瞻收益
            </Link>
          </div>
        </Panel>
        <section id="holding-risk">
          <Panel
            title="风险持仓"
            meta="完成bar价格；R=(现价−已核对成本)/(成本−止损)"
          >
            <AccountRiskLinks />
            {d.holdings === null ? (
              <p>尚未核对持仓，风险未知。</p>
            ) : d.holdings.length === 0 ? (
              <p>最近核对无持仓。</p>
            ) : (
              d.holdings.map((h) => (
                <div
                  key={`${h.market}:${h.account}:${h.symbol}`}
                  className="border-b py-2 text-sm"
                >
                  <Link
                    className="font-semibold underline"
                    href={`/accounts?position=${encodeURIComponent(h.market === "cn-equity" ? `local:${h.symbol}` : `crypto:${h.account}`)}`}
                  >
                    {h.symbol}
                  </Link>{" "}
                  · 距止损{" "}
                  {formatPercent(
                    h.stop === null
                      ? null
                      : ((h.price - h.stop) / h.price) * 100,
                  )}{" "}
                  · R{" "}
                  {formatNumber(
                    h.cost !== null && h.stop !== null && h.cost > h.stop
                      ? (h.price - h.cost) / (h.cost - h.stop)
                      : null,
                  )}
                  {h.stop !== null && h.price <= h.stop ? (
                    <strong className="text-nc-bad"> · 已跌破</strong>
                  ) : null}
                  <p className="text-xs text-nc-text-3">
                    {h.bar} ·{" "}
                    {h.cost === null ? "成本未核对；R留空" : "原价口径"}
                  </p>
                </div>
              ))
            )}
          </Panel>
        </section>
      </div>
      <Panel title="数据就绪" meta="读取本地回执与官方归档索引，不自动回填">
        <p>
          A股本地日线：{d.readiness.equity.localDate ?? "未知"} · 应到交易日：
          {d.readiness.equity.expectedDate ?? "待日历"} · 该日下载回执：
          {d.readiness.equity.receipt ? "已就绪" : "未就绪"} · A股扫描：
          {d.readiness.equity.ready
            ? "就绪"
            : d.readiness.equity.status === "unknown"
              ? "交易日历或本地证据待核验"
              : "日线或回执待补齐"}{" "}
          · BTC/ETH 1d/4h：
          {d.readiness.crypto.ready ? "就绪" : "待补齐"} · 提醒引擎最近运行：
          {d.runtime
            ? new Date(d.runtime.lastCheck).toLocaleString("zh-CN")
            : "尚未运行"}
        </p>
        {d.readiness.crypto.series.map((s) => (
          <p
            key={`${s.symbol}:${s.interval}`}
            className="text-xs text-nc-text-3"
          >
            {s.symbol} {s.interval} · 本地最新 {s.end ?? "缺失"} ·{" "}
            {s.ready ? "当前周期就绪" : `待核验（缺口${s.gaps ?? "未知"}）`}
          </p>
        ))}
        {d.gaps.length > 0 && (
          <div role="alert" className="mt-2 text-sm text-nc-warn">
            <p>扫描数据缺口（最近20项）：</p>
            {d.gaps.map((g) => (
              <p key={g.id}>
                {g.id} · {g.reason} · {new Date(g.at).toLocaleString("zh-CN")}
              </p>
            ))}
          </div>
        )}
        <p className="text-xs text-nc-text-3">
          {d.archive.series.filter((s) => s.manifest).length}/
          {d.archive.series.length} 组原生周期有索引；校验与覆盖详情见{" "}
          <Link href="/system" className="underline">
            数据与连接
          </Link>
          。
        </p>
      </Panel>
      <TodayIntel />
    </div>
  );
}
