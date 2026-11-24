"use client";

import { useEffect, useState } from "react";
import { ArrowClockwise as RefreshCw } from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import type { Snapshot } from "~/lib/domain";
import {
  draftFromInput,
  draftMatchesInput,
  initialMaDraft,
  jobStatusLabel,
  parseMaDraft,
  type MaDraft,
  type OrderFilter,
  type ReportTab,
} from "~/lib/backtest/ma-workspace";
import { Button } from "../ui/button";
import { activeJobPoll } from "../workbench/job-poll";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  MaExperimentConfig,
  type BaselineCoverage,
} from "./ma-experiment-config";
import { MaExperimentReport } from "../research/studio/ma-experiment-report";
import { FrozenJson } from "../research/studio/frozen-json";
import { StudioStep } from "../research/studio/studio-fields";
import { formatPercent } from "../research/diagnose/format";
import { FactorStrategyEditor } from "./factor-strategy-editor";

const firstPage = { pageIndex: 0, pageSize: 50 };
export function MaBaselinePanel({
  loaded,
  view,
  resultId,
  onResult,
  onReuse,
}: {
  loaded: Snapshot | null;
  view: "compose" | "result" | "inactive";
  resultId: string | null;
  onResult: (id: string) => void;
  onReuse: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    initialMaDraft(
      loaded?.symbol ?? "sz000001",
      loaded?.bars.at(-1)?.date.slice(0, 10) ??
        new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    ),
  );
  const [submittedId, setSubmittedId] = useState("");
  const id = resultId ?? submittedId;
  const [previousId, setPreviousId] = useState(id);
  const [shownId, setShownId] = useState("");
  const compose = view === "compose";
  const viewingResult = view === "result";
  const [tab, setTab] = useState<ReportTab>("overview");
  const [activity, setActivity] = useState<"fills" | "orders">("fills");
  const [pagination, setPagination] = useState(firstPage);
  const [orderPagination, setOrderPagination] = useState(firstPage);
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const [coverage, setCoverage] = useState<BaselineCoverage | null>(null);
  const [coverageError, setCoverageError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingReuse, setPendingReuse] = useState(false);
  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const visible = usePanelVisible();
  const utils = api.useUtils();
  if (id !== previousId) {
    setPreviousId(id);
    setTab("overview");
    setActivity("fills");
    setPagination(firstPage);
    setOrderPagination(firstPage);
    setOrderFilter("all");
    setNotice("");
    setPendingReuse(false);
    setExportError("");
  }
  const create = api.maBaseline.useMutation({
    onSuccess: (job) => {
      setSubmittedId(job.id);
      setShownId("");
      void utils.maBaselineHistory.invalidate();
    },
  });
  const job = api.jobSummary.useQuery(
    { id },
    {
      enabled: !!id && visible && view !== "inactive",
      refetchInterval: (q) =>
        visible && view !== "inactive" ? activeJobPoll(q.state.data) : false,
    },
  );
  const completed = job.data?.status === "completed";
  const result = api.maBaselineResult.useQuery(
    { id, pageIndex: 0 },
    { enabled: !!id && visible && viewingResult && completed },
  );
  const fills = api.maBaselineResult.useQuery(
    { id, pageIndex: pagination.pageIndex },
    {
      enabled:
        !!id &&
        visible &&
        viewingResult &&
        completed &&
        tab === "activity" &&
        activity === "fills",
    },
  );
  const orders = api.maBaselineOrders.useQuery(
    { id, pageIndex: orderPagination.pageIndex, status: orderFilter },
    {
      enabled:
        !!id &&
        visible &&
        viewingResult &&
        completed &&
        tab === "activity" &&
        activity === "orders",
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => {
      void job.refetch();
      void utils.maBaselineHistory.invalidate();
    },
  });
  useEffect(() => {
    if (
      id &&
      visible &&
      ["completed", "failed", "cancelled"].includes(job.data?.status ?? "")
    )
      void utils.maBaselineHistory.invalidate();
  }, [id, job.data?.status, visible, utils]);
  useEffect(() => {
    if (
      visible &&
      compose &&
      completed &&
      submittedId === id &&
      shownId !== id
    ) {
      onResult(id);
    }
  }, [visible, compose, completed, submittedId, shownId, id, onResult]);
  if (viewingResult && id && shownId !== id) setShownId(id);
  const running =
    create.isPending ||
    (!!id && job.isLoading) ||
    ["queued", "running"].includes(job.data?.status ?? "");
  const busy = running || reading || exporting;
  const parsed = parseMaDraft(draft);
  const coverageValidation =
    coverage?.unavailableReason ??
    (coverage?.earliestStart &&
    draft.start &&
    draft.start < coverage.earliestStart
      ? `开始日期至少为 ${coverage.earliestStart}，此前须保留 ${coverage.warmupBars} 根预热行情。`
      : coverage?.suggestedEnd && draft.end > coverage.suggestedEnd
        ? `结束日期不能晚于本地最后完整交易日 ${coverage.suggestedEnd}。`
        : coverage &&
            draft.start &&
            draft.end &&
            !coverage.runnableWindows.some(
              (window) =>
                draft.start >= window.start && draft.end <= window.end,
            )
          ? "所选窗口跨越本地已知不完整会话或缺少紧邻预热，请重新读取覆盖并选择可用区间。"
          : null);
  const data = completed ? result.data : null;
  function changeDraft(next: MaDraft) {
    if (
      next.symbol !== draft.symbol ||
      JSON.stringify(next.strategy) !== JSON.stringify(draft.strategy)
    ) {
      setCoverage(null);
      setCoverageError("");
    }
    setDraft(next);
    setNotice("");
    create.reset();
  }
  async function readCoverage() {
    setReading(true);
    setCoverage(null);
    setCoverageError("");
    try {
      const source = await utils.maBaselineCoverage.fetch({
        symbol: draft.symbol,
        strategy: draft.strategy,
      });
      setDraft((current) => ({
        ...current,
        start: source.suggestedStart ?? "",
        end: source.suggestedEnd ?? "",
      }));
      setCoverage(source);
      setCoverageError(source.unavailableReason ?? "");
    } catch (error) {
      setCoverageError(
        error instanceof Error
          ? error.message
          : "读取覆盖失败，请检查本地数据设置后重试。",
      );
    } finally {
      setReading(false);
    }
  }
  async function exportResult(format: "json" | "markdown") {
    setExporting(true);
    setExportError("");
    try {
      const archive = await utils.maBaselineExport.fetch(id);
      const { manifest } = archive;
      const content =
        format === "json"
          ? JSON.stringify(archive)
          : [
              `# 5m SMA 实验 · ${manifest.symbol}`,
              `- 实验编号：${id}`,
              `- 区间：${manifest.start} 至 ${manifest.end}`,
              `- 行情指纹：${manifest.dataHash}`,
              `- 累计收益：${formatPercent(data?.summary.totalReturn)}`,
              "",
              "历史实验仅用于规则和数据核对。完整冻结输入、订单与成交见 JSON 导出。",
            ].join("\n");
      const url = URL.createObjectURL(
        new Blob([content], {
          type:
            format === "json"
              ? "application/json"
              : "text/markdown;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${manifest.symbol}-${id}.${format === "json" ? "json" : "md"}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        format === "json"
          ? "已生成完整实验 JSON，包含冻结输入、订单和成交。"
          : "已生成实验 Markdown。",
      );
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "导出失败，请重试。",
      );
    } finally {
      setExporting(false);
    }
  }
  if (view === "inactive") return null;
  return (
    <section className="min-w-0 space-y-3" aria-label="策略回测实验室">
      {compose && (
        <>
          <StudioStep title="2. 基线与因子规则">
            <FactorStrategyEditor
              value={draft.strategy}
              disabled={busy}
              onChange={(strategy) => changeDraft({ ...draft, strategy })}
            />
          </StudioStep>
          <StudioStep title="3–5. 证券、区间、本金与执行">
            <MaExperimentConfig
              draft={draft}
              onChange={changeDraft}
              reading={reading}
              running={running}
              coverage={coverage}
              coverageError={coverageError}
              validationError={
                coverage?.unavailableReason ??
                parsed.error ??
                coverageValidation
              }
              onReadCoverage={() => void readCoverage()}
              onRun={() => {
                if (parsed.input && !busy && !coverageValidation) {
                  setNotice("");
                  setExportError("");
                  create.mutate(parsed.input);
                }
              }}
              onCancel={() => {
                if (id) cancel.mutate(id);
              }}
              cancelling={!id || create.isPending || cancel.isPending}
              startDisabled={exporting}
            />
            <FrozenJson value={parsed.input ?? draft} />
          </StudioStep>
        </>
      )}
      <div className="min-w-0 space-y-4">
        {(id || create.isPending) && (
          <section
            className="rounded-lg border border-nc-border bg-nc-card p-4"
            aria-label="实验运行状态"
          >
            <div role="status" aria-live="polite">
              <p className="text-sm font-medium">
                {create.isPending
                  ? "正在创建实验…"
                  : job.data
                    ? jobStatusLabel(job.data.status)
                    : job.isError
                      ? "实验状态读取失败"
                      : job.isLoading
                        ? "正在恢复实验…"
                        : "实验已不存在"}
              </p>
              {job.data && (
                <p className="mt-1 break-words text-sm text-nc-text-2">
                  {job.data.phase ?? jobStatusLabel(job.data.status)} ·{" "}
                  {job.data.progress}%
                </p>
              )}
              {job.data?.status === "cancelled" && (
                <p className="mt-2 text-sm text-nc-text-3">
                  本次已取消，无可用报告。可以调整配置重新运行，或恢复其他实验。
                </p>
              )}
              {job.data?.error && (
                <p
                  role="alert"
                  className="mt-2 break-words text-sm text-nc-bad"
                >
                  {job.data.error}
                </p>
              )}
            </div>
            {running && (
              <div
                role="progressbar"
                aria-label="实验进度"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={job.data?.progress ?? 0}
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-nc-inset"
              >
                <div
                  className="h-full bg-nc-accent"
                  style={{ width: `${job.data?.progress ?? 0}%` }}
                />
              </div>
            )}
            {viewingResult &&
              (job.data?.status === "queued" ||
                job.data?.status === "running") && (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(id)}
                >
                  {cancel.isPending ? "正在取消…" : "取消任务"}
                </Button>
              )}
            {job.error && (
              <div className="mt-2">
                <p role="alert" className="break-words text-sm text-nc-bad">
                  {job.error.message}
                </p>
                <Button
                  variant="outline"
                  className="mt-2 min-h-10"
                  onClick={() => void job.refetch()}
                >
                  重试读取实验
                </Button>
              </div>
            )}
          </section>
        )}
        {(create.error || cancel.error || exportError) && (
          <p
            role="alert"
            className="rounded-lg border border-nc-bad-edge p-3 text-sm text-nc-bad"
          >
            {create.error?.message ?? cancel.error?.message ?? exportError}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-lg border border-nc-border p-3 text-sm text-nc-text-2"
          >
            {notice}
          </p>
        )}
        {pendingReuse && viewingResult && data && (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-nc-warn-edge bg-nc-warn-soft p-3 text-sm text-nc-text-1"
          >
            <span>
              当前 5m SMA 编排草稿存在未保存修改，确认覆盖并复用所选实验配置？
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPendingReuse(false)}
              >
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setDraft(draftFromInput(data.summary.input));
                  setCoverage(null);
                  setCoverageError("");
                  create.reset();
                  setPendingReuse(false);
                  setNotice(
                    "已填入所选实验的原始配置，点击开始回测才会创建新实验。",
                  );
                  onReuse();
                }}
              >
                确认覆盖并复用
              </Button>
            </div>
          </div>
        )}
        {viewingResult && completed && result.isLoading && (
          <p
            role="status"
            className="rounded-lg border border-nc-border p-6 text-sm text-nc-text-3"
          >
            正在读取所选实验报告…
          </p>
        )}
        {viewingResult && completed && result.isSuccess && !data && (
          <p role="status">没有可用的实验报告。</p>
        )}
        {result.error && completed && (
          <div className="rounded-lg border border-nc-bad-edge p-4">
            <p role="alert" className="text-sm text-nc-bad">
              报告读取失败：{result.error.message}
            </p>
            <Button
              variant="outline"
              className="mt-3 min-h-10"
              onClick={() => void result.refetch()}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              重试报告
            </Button>
          </div>
        )}
        {viewingResult && data ? (
          <MaExperimentReport
            id={id}
            data={{ ...data, fills: fills.data?.fills ?? [] }}
            modified={!draftMatchesInput(draft, data.summary.input)}
            tab={tab}
            onTabChange={setTab}
            onReuse={() => {
              if (!draftMatchesInput(draft, data.summary.input)) {
                setPendingReuse(true);
                return;
              }
              setDraft(draftFromInput(data.summary.input));
              setCoverage(null);
              setCoverageError("");
              create.reset();
              setPendingReuse(false);
              setNotice(
                "已填入所选实验的原始配置，点击开始回测才会创建新实验。",
              );
              onReuse();
            }}
            onExport={() => void exportResult("json")}
            onMarkdown={() => void exportResult("markdown")}
            exporting={exporting}
            fillPagination={pagination}
            onFillPaginationChange={setPagination}
            fillsLoading={fills.isFetching}
            fillsError={fills.error?.message}
            onRetryFills={() => void fills.refetch()}
            activity={activity}
            onActivityChange={setActivity}
            orderFilter={orderFilter}
            onOrderFilterChange={(value) => {
              setOrderFilter(value);
              setOrderPagination(firstPage);
            }}
            orders={orders.data}
            ordersLoading={orders.isFetching}
            ordersError={orders.error?.message}
            onRetryOrders={() => void orders.refetch()}
            orderPagination={orderPagination}
            onOrderPaginationChange={setOrderPagination}
          />
        ) : null}
      </div>
    </section>
  );
}
