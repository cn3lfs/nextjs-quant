import { formatEvidenceText } from "~/lib/common/evidence-text";
import { formatNumber } from "trading-strategy-core/format-number";
import { PanelVisibility, usePanelVisible } from "./keep-alive";
import { ResearchUsageContainer } from "~/components/research/research-usage-container";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DataTable } from "~/components/ui/data-table";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { ArrowUpRight } from "@phosphor-icons/react/ssr";
import { screenSortLabels, type ScreenSort } from "~/lib/screening/screen-sort";
import {
  currentScreenCandidateIndex,
  openScreenCandidate,
  screenCandidateUrlKey,
  type ScreenCandidateIdentity,
} from "~/lib/screening/screen-candidate-navigation";
import {
  screenMonitorCaptureMatches,
  screenMonitorContentSignature,
  screenMonitorPreview,
} from "~/lib/screening/screen-monitor-preview";
import { PopoverContent, PopoverTrigger } from "../ui/popover";
import { PanelPopover } from "./panel-popover";
import {
  archivedNameHint,
  securityDisplayName,
} from "~/lib/market/security-display";
import { FormulaScreen } from "../screening/formula-screen";
import { FactorEvaluationPanel } from "../research/factor-evaluation-panel";
import { ScreenTaskProgress } from "../screening/screen-task-progress";
import { Button } from "../ui/button";
import { DownloadSimple, ListDashes } from "@phosphor-icons/react/ssr";
import {
  FilterDivider,
  FilterGroup,
  FilterToolbar,
  MethodologyPopover,
  PageGrid,
  Panel,
  Pill,
  Segmented,
} from "../panels";

import { Empty, fmt, ResultPager } from "./shared";
import type { ScreenViewState } from "../screening/screen-workspace";

/** Candidate table column → server-side screen sort key. */
const screenSortColumn: Record<Exclude<ScreenSort, "original">, string> = {
  symbol: "column-0",
  close: "column-2",
  change: "column-3",
  volumeRatio: "column-4",
  score: "column-5",
};

export function ScreenView({ state }: { state: ScreenViewState }) {
  const router = useRouter();
  const search = useSearchParams();
  const {
    screenPage,
    setScreenPage,
    excludedPage,
    setExcludedPage,
    errorPage,
    setErrorPage,
    screenQuery,
    setScreenQuery,
    screenSort,
    setScreenSort,
    screenDirection,
    setScreenDirection,
    names,
    utils,
    screenJob,
    screenId,
    selectedScreen,
    firstScreenPage,
    screened,
    exportingScreen,
    exportScreen,
    screenResult,
  } = state;
  const [formulaView, setFormulaView] = useState<"screen" | "factor">("screen");
  // Null follows the default: a finished result collapses the editor, no result
  // keeps it open. An explicit choice survives re-renders and task changes.
  const [editorToggle, setEditorToggle] = useState<"open" | "closed" | null>(
    null,
  );
  // This panel stays mounted behind other tabs. Leaving the formula workspace
  // discards the confirmed page, any pending read and its error.
  const visible = usePanelVisible();
  // The first page comes from jobSummary while other pages come from
  // screenResults; the query that actually supplies the rows owns the state.
  const pageQuery = firstScreenPage ? selectedScreen : screened;
  // Only a confirmed page may move the frozen chart or seed a monitor draft.
  // Fetching/placeholder rows belong to the previous query and are never input.
  const pageUnavailable =
    !visible ||
    !screenResult ||
    pageQuery.isFetching ||
    screened.isPlaceholderData ||
    pageQuery.isError;
  const urlCandidate = {
    symbol: search.get("symbol"),
    snapshotId: search.get("screenSnapshot"),
  };
  const urlJob = search.get("screenJob");
  const currentUrlKey = screenCandidateUrlKey(search);
  const pageKey =
    visible && screenResult && screenJob
      ? JSON.stringify([
          screenJob.id,
          screenPage,
          screenQuery,
          screenSort,
          screenDirection,
          currentUrlKey,
        ])
      : "";
  // The preview list and the draft link come from the same confirmed snapshot
  // array, so the rows shown are exactly the symbols carried over.
  const monitorPreview =
    !pageUnavailable && screenResult
      ? screenMonitorPreview({
          asOf: screenResult.asOf,
          count: screenResult.count,
          candidates: screenResult.candidates,
        })
      : null;
  const monitorContent =
    !pageUnavailable && screenResult
      ? screenMonitorContentSignature({
          asOf: screenResult.asOf,
          count: screenResult.count,
          candidates: screenResult.candidates,
        })
      : "";
  const confirmed = useRef<{
    key: string;
    content: string;
    candidates: readonly ScreenCandidateIdentity[];
  }>({ key: "", content: "", candidates: [] });
  confirmed.current = {
    key: pageUnavailable ? "" : pageKey,
    content: pageUnavailable ? "" : monitorContent,
    candidates: pageUnavailable ? [] : (screenResult?.candidates ?? []),
  };
  const attempts = useRef(0);
  const [opening, setOpening] = useState<ScreenCandidateIdentity | null>(null);
  const [openError, setOpenError] = useState<{
    candidate: ScreenCandidateIdentity;
    message: string;
  } | null>(null);
  const candidates = screenResult?.candidates ?? [];
  const candidateIndex = currentScreenCandidateIndex(candidates, urlCandidate);
  // Neighbours may only step this task's own frozen candidate. A URL frozen by
  // another task still allows re-opening a row of the confirmed page.
  const frozenTaskMatches = !!screenJob && urlJob === screenJob.id;
  const navReady = !pageUnavailable && candidateIndex >= 0 && frozenTaskMatches;
  const positionText = pageUnavailable
    ? "—/—"
    : candidateIndex >= 0 && frozenTaskMatches
      ? `${candidateIndex + 1}/${candidates.length}`
      : `—/${candidates.length}`;
  const monitorCapture = useRef<{
    key: string;
    content: string;
    urlKey: string;
    href: string;
  } | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  // A preview is only usable while it still describes the page on screen: the
  // task/page/query key, the rows and the URL all have to match what was
  // captured. A render that invalidates it drops the Portal immediately, before
  // the effect below gets a chance to run.
  const captured = monitorCapture.current;
  const previewCurrent =
    !!captured &&
    captured.key === confirmed.current.key &&
    captured.content === confirmed.current.content &&
    captured.urlKey === currentUrlKey;
  useEffect(() => {
    // A reload, another page/key or changed rows invalidate the open preview;
    // the user must reopen and confirm, and nothing is sent automatically after
    // the data recovers.
    monitorCapture.current = null;
    setMonitorOpen(false);
  }, [pageKey, monitorContent]);
  useEffect(() => {
    // A new task/page/query/URL candidate invalidates an in-flight read and its error.
    attempts.current++;
    setOpening(null);
    setOpenError(null);
  }, [pageKey]);
  useEffect(
    () => () => {
      // Unmounting (leaving the formula workspace) must not navigate later.
      attempts.current++;
    },
    [],
  );
  async function openCandidate(candidate: ScreenCandidateIdentity) {
    const jobId = screenJob?.id;
    const key = confirmed.current.key;
    if (!jobId || !key) return;
    const attempt = ++attempts.current;
    setOpening(candidate);
    setOpenError(null);
    const outcome = await openScreenCandidate({
      candidate,
      jobId,
      pageKey: key,
      fetchSnapshot: (id) => utils.savedSnapshot.fetch(id),
      readPageKey: () => {
        // Back/forward can commit before React re-renders; compare the native
        // location with the URL this read was started from.
        const native =
          typeof window === "undefined"
            ? search
            : new URLSearchParams(window.location.search);
        return screenCandidateUrlKey(native) === currentUrlKey
          ? confirmed.current.key
          : "";
      },
      containsCandidate: () =>
        confirmed.current.candidates.some(
          (row) =>
            row.symbol === candidate.symbol &&
            row.snapshotId === candidate.snapshotId,
        ),
      isLatest: () => attempts.current === attempt,
      navigate: (href) => router.push(href, { scroll: false }),
    });
    if (attempts.current !== attempt) return;
    setOpening(null);
    if (outcome.status === "invalid" || outcome.status === "failed")
      setOpenError({ candidate, message: outcome.message });
  }
  function openMonitorPreview() {
    // Capture the page, its content, the URL and the href built from this very
    // preview; confirming never rebuilds the link from later render data.
    if (
      pageUnavailable ||
      !monitorPreview ||
      !pageKey ||
      confirmed.current.key !== pageKey ||
      confirmed.current.content !== monitorContent
    )
      return;
    monitorCapture.current = {
      key: pageKey,
      content: monitorContent,
      urlKey: currentUrlKey,
      href: monitorPreview.href,
    };
    setMonitorOpen(true);
  }
  function confirmMonitorDraft() {
    // Consume the capture first so a second click in the same tick is a no-op.
    const capture = monitorCapture.current;
    monitorCapture.current = null;
    if (!capture) return;
    // Compare the latest committed ref (not this handler's closure) and the
    // browser's own query, which can move before React re-renders.
    const native =
      typeof window === "undefined"
        ? search
        : new URLSearchParams(window.location.search);
    const latest = {
      key: confirmed.current.key,
      content: confirmed.current.content,
      urlKey: screenCandidateUrlKey(native),
    };
    setMonitorOpen(false);
    if (!screenMonitorCaptureMatches(capture, latest)) return;
    router.push(capture.href, { scroll: false });
  }
  // A completed result collapses the entry form into a one-line summary; the
  // form stays mounted (hidden) so drafts and gate state survive.
  const formulaCollapsed =
    formulaView === "screen" &&
    !!screenResult &&
    (editorToggle ?? "closed") === "closed";
  const runElapsed = screenResult
    ? screenResult.elapsedMs !== undefined
      ? `耗时 ${formatNumber(screenResult.elapsedMs / 1000, 2)} 秒`
      : "耗时未记录"
    : "";
  const resultMethodology = screenResult
    ? [
        {
          label: "公式口径与描述指标",
          detail: screenResult.formula
            ? `公式「${screenResult.formula.name}」参数：${formatEvidenceText(screenResult.formula.parameters)}。下表均线差与量比仅作描述，不参与公式选中判定。`
            : "下表均线差与量比仅作描述，不参与公式选中判定。",
        },
        {
          label: "本地日线时点与研究警示",
          detail: `行情来源为本地已完成日线。${screenResult.asOf ?? "无可用基准日"} 为本次选股基准日；本地数据可能落后于今天，不自动生成分析，也不承诺为当前交易日。${
            screenResult.researchWarnings.length
              ? `研究警示：${screenResult.researchWarnings.join("；")}。`
              : ""
          }`,
        },
        ...(screenResult.formula
          ? [
              {
                label: "本次执行公式源码快照",
                detail: screenResult.formula.source,
              },
            ]
          : []),
      ]
    : [];
  return (
    <PageGrid>
      {/* Keep forms mounted so switching preserves drafts, validation and pending submissions. */}
      <div id="screen-entry-formula" className="nc-span-12 min-w-0">
        {formulaView === "screen" && screenResult ? (
          <div className="mb-4 flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-border bg-card px-3 py-1.5">
            <Pill tone="accent">已执行公式</Pill>
            <strong className="min-w-0 truncate text-sm">
              {screenResult.formula?.name ?? "公式任务"}
            </strong>
            {screenResult.formula && (
              <span className="min-w-0 truncate text-xs text-nc-text-3">
                参数 {formatEvidenceText(screenResult.formula.parameters)}
              </span>
            )}
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums text-nc-text-2">
              <span>命中 {screenResult.candidateTotal}</span>
              <span aria-hidden="true">/</span>
              <span>检查 {screenResult.total}</span>
              <span aria-hidden="true">·</span>
              <span>隔离 {screenResult.excludedTotal}</span>
              <span aria-hidden="true">·</span>
              <span>基准日 {screenResult.asOf ?? "无"}</span>
              <span aria-hidden="true">·</span>
              <span>{runElapsed}</span>
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setEditorToggle(formulaCollapsed ? "open" : "closed")
                }
              >
                {formulaCollapsed ? "展开编辑公式" : "收拢条件摘要"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFormulaView("factor")}
              >
                切换单因子评估
              </Button>
            </div>
          </div>
        ) : (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            {formulaView === "factor" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFormulaView("screen")}
              >
                ← 返回公式筛选
              </Button>
            ) : (
              <Segmented
                label="公式工作区"
                value={formulaView}
                onChange={setFormulaView}
                options={[
                  { value: "screen", label: "公式筛选" },
                  { value: "factor", label: "单因子评估" },
                ]}
              />
            )}
            <Button asChild variant="ghost" size="sm">
              <a href="/lab/reports">财务研究与筛选 →</a>
            </Button>
          </div>
        )}
        <PanelVisibility visible={formulaView === "screen"}>
          <div hidden={formulaView !== "screen" || formulaCollapsed}>
            <FormulaScreen onStarted={state.selectFormulaJob} />
          </div>
        </PanelVisibility>
        <PanelVisibility visible={formulaView === "factor"}>
          <div hidden={formulaView !== "factor"}>
            <FactorEvaluationPanel />
          </div>
        </PanelVisibility>
      </div>
      <div
        className="nc-span-12 min-w-0 space-y-4"
        hidden={formulaView === "factor"}
      >
        {screenId && selectedScreen?.isLoading && (
          <p role="status">正在读取选中的公式任务…</p>
        )}
        {selectedScreen?.error && (
          <p role="alert">
            历史任务读取失败：{selectedScreen.error.message}{" "}
            <Button
              variant="outline"
              onClick={() => void selectedScreen.refetch()}
            >
              重试读取任务
            </Button>
          </p>
        )}
        {screenId && selectedScreen?.data === null && (
          <p role="alert">任务不存在，可能已被清理。请到任务中心重新选择。</p>
        )}
        {selectedScreen?.data && !selectedScreen.data.isFormulaScreen && (
          <p role="alert">所选任务不是公式选股任务，请到任务中心重新选择。</p>
        )}
        <Panel
          icon={ListDashes}
          title="候选结果"
          tag={`${screenResult?.candidateTotal ?? "—"} 个`}
          meta={
            screenResult
              ? `已检查 ${screenResult.total} 个 · ${screenResult.errorTotal} 个读取异常 · ${screenResult.excludedTotal} 个已隔离`
              : screenJob?.status === "completed"
                ? "任务已完成，候选结果尚未读取"
                : "运行后显示真实结果"
          }
          actions={
            screenResult ? (
              <MethodologyPopover
                title="候选结果口径"
                items={resultMethodology}
              />
            ) : undefined
          }
        >
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
              {screenResult.formula && (
                <ResearchUsageContainer key={screenJob?.id} />
              )}
              <FilterToolbar label="候选结果工具栏">
                <FilterGroup>
                  <Input
                    aria-label="筛选候选名称或代码"
                    placeholder="搜代码/名称"
                    className="h-8 w-44"
                    value={screenQuery}
                    onChange={(e) => {
                      setScreenQuery(e.target.value);
                      setScreenPage(0);
                    }}
                  />
                </FilterGroup>
                <FilterGroup>
                  <Select
                    value={screenSort}
                    onValueChange={(selected) => {
                      setScreenSort(selected as ScreenSort);
                      setScreenPage(0);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="候选排序字段"
                      className="w-32 shrink-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(screenSortLabels).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                  <Select
                    value={screenDirection}
                    disabled={screenSort === "original"}
                    onValueChange={(selected) => {
                      setScreenDirection(selected as "asc" | "desc");
                      setScreenPage(0);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label="候选排序方向"
                      className="w-28 shrink-0"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="desc">从高到低</SelectItem>
                      <SelectItem value="asc">从低到高</SelectItem>
                    </SelectContent>
                  </Select>
                </FilterGroup>
                <FilterDivider />
                <FilterGroup>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="上一页"
                    disabled={screenPage === 0 || screened.isFetching}
                    onClick={() => setScreenPage(screenPage - 1)}
                  >
                    ‹
                  </Button>
                  <span className="whitespace-nowrap text-xs tabular-nums">
                    第 {screenPage + 1}/
                    {Math.max(1, Math.ceil(screenResult.count / 50))} 页 ·{" "}
                    {screenResult.count} 条
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="下一页"
                    disabled={
                      (screenPage + 1) * 50 >= screenResult.count ||
                      screened.isFetching
                    }
                    onClick={() => setScreenPage(screenPage + 1)}
                  >
                    ›
                  </Button>
                </FilterGroup>
                <FilterDivider />
                <FilterGroup>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!navReady || candidateIndex <= 0}
                    onClick={() => {
                      const target = candidates[candidateIndex - 1];
                      if (target) void openCandidate(target);
                    }}
                  >
                    上一只
                  </Button>
                  <span
                    role="status"
                    className="whitespace-nowrap text-xs tabular-nums"
                    title="当前冻结候选在本页候选中的位置"
                  >
                    本页 {positionText}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !navReady || candidateIndex >= candidates.length - 1
                    }
                    onClick={() => {
                      const target = candidates[candidateIndex + 1];
                      if (target) void openCandidate(target);
                    }}
                  >
                    下一只
                  </Button>
                  {opening && (
                    <span className="text-xs text-nc-text-3">读取中…</span>
                  )}
                </FilterGroup>
                <FilterDivider />
                {screenResult.candidates.length > 0 && (
                  <PanelPopover
                    open={monitorOpen && previewCurrent}
                    onOpenChange={(next) => {
                      if (next) {
                        openMonitorPreview();
                      } else {
                        monitorCapture.current = null;
                        setMonitorOpen(false);
                      }
                    }}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pageUnavailable}
                      >
                        查看监控名单
                      </Button>
                    </PopoverTrigger>
                    {monitorPreview && previewCurrent && (
                      <PopoverContent aria-label="监控名单预览">
                        <div className="space-y-2">
                          <p className="text-xs text-nc-text-3">
                            基准日 {monitorPreview.asOf ?? "无可用基准日"} ·
                            本页 {monitorPreview.pageCount} 只 / 共{" "}
                            {monitorPreview.totalCount} 只
                          </p>
                          {monitorPreview.overflow > 0 && (
                            <p className="text-xs text-nc-text-3">
                              单个订阅最多 {monitorPreview.limit} 只：本次带入前{" "}
                              {monitorPreview.included} 只，本页其余{" "}
                              {monitorPreview.overflow} 只不会带入。
                            </p>
                          )}
                          <ul
                            className="space-y-1 text-sm"
                            aria-label="带入监控的候选"
                          >
                            {monitorPreview.rows.map((row) => (
                              <li
                                key={row.symbol}
                                className="flex items-baseline justify-between gap-2"
                              >
                                <span>
                                  <strong
                                    title={archivedNameHint(
                                      row.symbol,
                                      names,
                                      row.name,
                                    )}
                                  >
                                    {securityDisplayName(
                                      row.symbol,
                                      names,
                                      row.name,
                                    )}
                                  </strong>{" "}
                                  <small>{row.symbol}</small>
                                </span>
                                <span className="text-xs text-nc-text-3">
                                  {row.date}
                                </span>
                              </li>
                            ))}
                          </ul>
                          <p className="text-xs text-nc-text-3">
                            打开后是未保存的监控草稿，不会自动启用；请在信号页选择策略与渠道后自行保存。
                          </p>
                          <Button
                            size="sm"
                            disabled={pageUnavailable}
                            onClick={confirmMonitorDraft}
                          >
                            打开监控草稿
                          </Button>
                        </div>
                      </PopoverContent>
                    )}
                  </PanelPopover>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    exportingScreen || screenJob?.status !== "completed"
                  }
                  onClick={exportScreen}
                >
                  <DownloadSimple size={13} />
                  {exportingScreen ? "导出中…" : "导出结果"}
                </Button>
              </FilterToolbar>
              {openError && (
                <div role="alert" className="notice">
                  <p>
                    读取候选快照失败：{openError.message}
                    。当前图表和地址未改变。
                  </p>
                  <Button
                    disabled={pageUnavailable}
                    onClick={() => void openCandidate(openError.candidate)}
                  >
                    重试读取候选
                  </Button>
                </div>
              )}
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
                <DataTable
                  label="候选结果"
                  data={screenResult.candidates}
                  columns={[
                    {
                      id: "column-0",
                      header: "证券",
                      enableSorting: true,
                      cell: ({ row }) => {
                        const c = row.original;
                        return (
                          <>
                            <strong
                              title={archivedNameHint(c.symbol, names, c.name)}
                            >
                              {securityDisplayName(c.symbol, names, c.name)}
                            </strong>
                            <small>{c.symbol}</small>
                          </>
                        );
                      },
                    },
                    {
                      id: "column-1",
                      header: "数据时间",
                      enableSorting: false,
                      cell: ({ row }) => {
                        const c = row.original;
                        return <>{c.metrics.date}</>;
                      },
                    },
                    {
                      id: "column-2",
                      header: "收盘",
                      enableSorting: true,
                      cell: ({ row }) => {
                        const c = row.original;
                        return <>{fmt(c.metrics.close)}</>;
                      },
                    },
                    {
                      id: "column-3",
                      header: "涨跌幅",
                      enableSorting: true,
                      cell: ({ row }) => {
                        const c = row.original;
                        return (
                          <span
                            className={c.metrics.change >= 0 ? "up" : "down"}
                          >
                            {fmt(c.metrics.change)}%
                          </span>
                        );
                      },
                    },
                    {
                      id: "column-4",
                      header: "量比",
                      enableSorting: true,
                      cell: ({ row }) => {
                        const c = row.original;
                        return <>{fmt(c.metrics.volumeRatio)}</>;
                      },
                    },
                    {
                      id: "column-5",
                      header: "趋势分",
                      enableSorting: true,
                      cell: ({ row }) => {
                        const c = row.original;
                        return <>{fmt(c.metrics.score)}</>;
                      },
                    },
                    {
                      id: "column-7",
                      header: "",
                      enableSorting: false,
                      cell: ({ row }) => {
                        const c = row.original;
                        return (
                          <>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={pageUnavailable}
                              onClick={() => void openCandidate(c)}
                            >
                              个股研究 <ArrowUpRight size={13} />
                            </Button>
                          </>
                        );
                      },
                    },
                  ]}
                  getRowId={(c) => String(c.symbol)}
                  rowCount={screenResult.count}
                  pagination={{ pageIndex: screenPage, pageSize: 50 }}
                  sorting={
                    screenSort === "original"
                      ? []
                      : [
                          {
                            id: screenSortColumn[screenSort],
                            desc: screenDirection === "desc",
                          },
                        ]
                  }
                  onPaginationChange={() => {}}
                  onSortingChange={(updater) => {
                    const current =
                      screenSort === "original"
                        ? []
                        : [
                            {
                              id: screenSortColumn[screenSort],
                              desc: screenDirection === "desc",
                            },
                          ];
                    const next = (
                      typeof updater === "function" ? updater(current) : updater
                    )[0];
                    const sort = next
                      ? (Object.entries(screenSortColumn).find(
                          ([, column]) => column === next.id,
                        )?.[0] as ScreenSort | undefined)
                      : undefined;
                    setScreenSort(sort ?? "original");
                    if (next) setScreenDirection(next.desc ? "desc" : "asc");
                    setScreenPage(0);
                  }}
                  showPagination={false}
                  emptyMessage={null}
                />
              </div>
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
                    <DataTable
                      label="隔离原因"
                      data={screenResult.excluded}
                      columns={[
                        {
                          id: "column-0",
                          header: "证券",
                          enableSorting: false,
                          cell: ({ row }) => {
                            const item = row.original;
                            return (
                              <>
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
                              </>
                            );
                          },
                        },
                        {
                          id: "column-1",
                          header: "数据时间",
                          enableSorting: false,
                          cell: ({ row }) => {
                            const item = row.original;
                            return <>{item.date ?? "—"}</>;
                          },
                        },
                        {
                          id: "column-2",
                          header: "原因",
                          enableSorting: false,
                          cell: ({ row }) => {
                            const item = row.original;
                            return <>{item.reason}</>;
                          },
                        },
                      ]}
                      getRowId={(item) => String(item.symbol)}
                      rowCount={screenResult.excludedTotal}
                      pagination={{ pageIndex: excludedPage, pageSize: 50 }}
                      sorting={[]}
                      onPaginationChange={() => {}}
                      onSortingChange={() => {}}
                      showPagination={false}
                      emptyMessage={null}
                    />
                  </div>
                </details>
              )}
              {screenResult.errorTotal > 0 && (
                <details>
                  <summary>读取异常明细（{screenResult.errorTotal}）</summary>
                  <ResultPager
                    page={errorPage}
                    count={screenResult.errorTotal}
                    onChange={setErrorPage}
                  />
                  <pre>{formatEvidenceText(screenResult.errors)}</pre>
                </details>
              )}
            </>
          ) : (
            screenJob?.status !== "completed" && (
              <Empty>
                运行公式筛选，结果会附带数据时间。公式计算不会自动生成分析、通知或交易。
              </Empty>
            )
          )}
        </Panel>
      </div>
    </PageGrid>
  );
}
