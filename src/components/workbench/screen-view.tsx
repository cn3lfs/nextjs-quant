import { formatNumber } from "~/lib/common/format-number";
import { PanelVisibility } from "./keep-alive";
import { ResearchUsageContainer } from "~/components/research/research-usage-container";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  monitorPrefillHref,
  monitorSymbolLimit,
} from "~/lib/strategy-facts/monitor-workspace-draft";
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
  archivedNameHint,
  securityDisplayName,
} from "~/lib/market/security-display";
import { FormulaScreen } from "../screening/formula-screen";
import { FactorEvaluationPanel } from "../research/factor-evaluation-panel";
import { ScreenTaskProgress } from "../screening/screen-task-progress";
import { Button } from "../ui/button";
import { DownloadSimple, Gauge, ListDashes } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Segmented, StatsPanel } from "../panels";

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
  const {
    setSymbol,
    setBrowse,
    setPeriod,
    load,
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
    notify,
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
  return (
    <PageGrid>
      {/* Keep forms mounted so switching preserves drafts, validation and pending submissions. */}
      <div id="screen-entry-formula" className="nc-span-12 min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <Segmented
            label="公式工作区"
            value={formulaView}
            onChange={setFormulaView}
            options={[
              { value: "screen", label: "公式筛选" },
              { value: "factor", label: "单因子评估" },
            ]}
          />
          <Button asChild variant="ghost" size="sm">
            <a href="/lab/reports">财务研究与筛选 →</a>
          </Button>
        </div>
        <PanelVisibility visible={formulaView === "screen"}>
          <div hidden={formulaView !== "screen"}>
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
        {screenResult && (
          <StatsPanel
            icon={Gauge}
            title="本次运行"
            meta={`基准日 ${screenResult.asOf ?? "无可用基准日"} · ${
              screenResult.elapsedMs !== undefined
                ? `本地计算 ${formatNumber(screenResult.elapsedMs / 1000, 2)} 秒`
                : "耗时未记录"
            }`}
            items={[
              {
                label: "候选",
                value: screenResult.candidateTotal,
                note: screenSortLabels[screenSort],
              },
              { label: "已检查", value: screenResult.total },
              {
                label: "已隔离",
                value: screenResult.excludedTotal,
                note: "停牌 / ST / 次新等",
                tone: screenResult.excludedTotal ? "warn" : "neutral",
              },
              {
                label: "读取异常",
                value: screenResult.errorTotal,
                note: screenResult.errorTotal ? "见下方明细" : undefined,
                tone: screenResult.errorTotal ? "bad" : "neutral",
              },
              {
                label: "数据模式",
                value: "本地已完成日线",
                note: "不承诺为当前交易日",
              },
            ]}
          />
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
            <Button
              size="sm"
              variant="outline"
              disabled={exportingScreen || screenJob?.status !== "completed"}
              onClick={exportScreen}
            >
              <DownloadSimple size={13} />
              {exportingScreen ? "导出中…" : "导出本次完整结果"}
            </Button>
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
              {screenResult.formula && (
                <div className="notice">
                  <strong>公式：{screenResult.formula.name}</strong>
                  <p>
                    参数：{JSON.stringify(screenResult.formula.parameters)}
                    。下表均线差与量比仅作描述，不参与公式选中判定。
                  </p>
                  <details>
                    <summary>本次执行公式快照</summary>
                    <pre>{screenResult.formula.source}</pre>
                  </details>
                </div>
              )}
              <p className="muted">
                选股基准日：
                {screenResult.asOf ?? "无可用基准日"} ·{" "}
                {screenResult.elapsedMs !== undefined
                  ? `本地计算 ${formatNumber(screenResult.elapsedMs / 1000, 2)} 秒`
                  : "耗时未记录"}
                。本地数据可能落后于今天，不自动生成分析。
              </p>
              <p className="muted">
                {screenResult.researchWarnings.join("；")}
              </p>
              <div className="inline-form">
                <Input
                  aria-label="筛选候选名称或代码"
                  placeholder="搜索候选名称或代码"
                  value={screenQuery}
                  onChange={(e) => {
                    setScreenQuery(e.target.value);
                    setScreenPage(0);
                  }}
                />
                <Select
                  value={screenSort}
                  onValueChange={(selected) => {
                    setScreenSort(selected as ScreenSort);
                    setScreenPage(0);
                  }}
                >
                  <SelectTrigger
                    aria-label="候选排序字段"
                    className="w-40 shrink-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(screenSortLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
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
                    aria-label="候选排序方向"
                    className="w-40 shrink-0"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="desc">从高到低</SelectItem>
                    <SelectItem value="asc">从低到高</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  disabled={screenPage === 0 || screened.isFetching}
                  onClick={() => setScreenPage(screenPage - 1)}
                >
                  上一页
                </Button>
                <span className="shrink-0 whitespace-nowrap">
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
              {screenResult.candidates.length > 0 && (
                <div className="inline-form">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={screened.isPlaceholderData}
                    onClick={() =>
                      router.push(
                        monitorPrefillHref({
                          name: `选股候选 ${screenResult.asOf ?? ""}`.trim(),
                          symbols: screenResult.candidates
                            .slice(0, monitorSymbolLimit)
                            .map((c) => c.symbol),
                        }),
                      )
                    }
                  >
                    本页前{" "}
                    {Math.min(
                      monitorSymbolLimit,
                      screenResult.candidates.length,
                    )}{" "}
                    只加入监控
                  </Button>
                  <span className="text-xs text-nc-text-3">
                    按当前排序取本页；在信号页选择策略与渠道后保存，保存前不会启用。
                    {screenResult.candidates.length > monitorSymbolLimit &&
                      ` 单个订阅最多 ${monitorSymbolLimit} 只。`}
                  </span>
                </div>
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
                              disabled={
                                !firstScreenPage &&
                                (screened.isPlaceholderData || screened.isError)
                              }
                              onClick={async () => {
                                try {
                                  const source =
                                    await utils.savedSnapshot.fetch(
                                      c.snapshotId,
                                    );
                                  setBrowse({
                                    label: "选股候选",
                                    symbols: screenResult.candidates.map(
                                      (x) => x.symbol,
                                    ),
                                    index: screenResult.candidates.indexOf(c),
                                  });
                                  setSymbol(c.symbol);
                                  setPeriod(source.period);
                                  load.acceptSnapshot(source);
                                  router.push(
                                    `/scan?tab=formula&symbol=${encodeURIComponent(c.symbol)}&screenSnapshot=${encodeURIComponent(source.id)}&screenJob=${encodeURIComponent(screenJob!.id)}&adjustment=${source.adjustment ?? "none"}`,
                                    { scroll: false },
                                  );
                                } catch (error) {
                                  notify(
                                    error instanceof Error
                                      ? error.message
                                      : "读取快照失败",
                                  );
                                }
                              }}
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
                  <pre>{JSON.stringify(screenResult.errors, null, 2)}</pre>
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
