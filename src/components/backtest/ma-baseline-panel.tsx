"use client";

import { useEffect, useState } from "react";
import { FlaskConical, RefreshCw } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { activeJobPoll } from "../workbench/job-poll";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  MaExperimentConfig,
  type BaselineCoverage,
} from "./ma-experiment-config";
import { MaExperimentHistory } from "./ma-experiment-history";
import { MaExperimentReport } from "./ma-experiment-report";
import { FactorStrategyEditor } from "./factor-strategy-editor";

const firstPage = { pageIndex: 0, pageSize: 50 };
export function MaBaselinePanel({ loaded }: { loaded: Snapshot | null }) {
  const [draft, setDraft] = useState(() =>
    initialMaDraft(
      loaded?.symbol ?? "sz000001",
      loaded?.bars.at(-1)?.date.slice(0, 10) ??
        new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10),
    ),
  );
  const [id, setId] = useState("");
  const [tab, setTab] = useState<ReportTab>("overview");
  const [activity, setActivity] = useState<"fills" | "orders">("fills");
  const [pagination, setPagination] = useState(firstPage);
  const [orderPagination, setOrderPagination] = useState(firstPage);
  const [orderFilter, setOrderFilter] = useState<OrderFilter>("all");
  const [coverage, setCoverage] = useState<BaselineCoverage | null>(null);
  const [coverageError, setCoverageError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const history = api.maBaselineHistory.useQuery(undefined, {
    enabled: visible,
  });
  function selectExperiment(value: string) {
    setId(value);
    setTab("overview");
    setPagination(firstPage);
    setOrderPagination(firstPage);
    setOrderFilter("all");
    setDeleteOpen(false);
    setNotice("");
    setExportError("");
    create.reset();
    cancel.reset();
    remove.reset();
  }
  const create = api.maBaseline.useMutation({
    onSuccess: (job) => {
      selectExperiment(job.id);
      void utils.maBaselineHistory.invalidate();
    },
  });
  const job = api.jobSummary.useQuery(
    { id },
    {
      enabled: !!id && visible,
      refetchInterval: (q) => (visible ? activeJobPoll(q.state.data) : false),
    },
  );
  const completed = job.data?.status === "completed";
  const result = api.maBaselineResult.useQuery(
    { id, pageIndex: 0 },
    { enabled: !!id && visible && completed },
  );
  const fills = api.maBaselineResult.useQuery(
    { id, pageIndex: pagination.pageIndex },
    {
      enabled:
        !!id &&
        visible &&
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
  const remove = api.maBaselineRemove.useMutation({
    onSuccess: async (_, removedId) => {
      setDeleteOpen(false);
      if (id === removedId) setId("");
      setNotice("实验及其冻结输入已删除，审计事实保留。");
      await utils.maBaselineHistory.invalidate();
      await utils.maBaselineResult.invalidate({ id: removedId });
      await utils.maBaselineOrders.invalidate({ id: removedId });
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
  const running =
    create.isPending ||
    (!!id && job.isLoading) ||
    ["queued", "running"].includes(job.data?.status ?? "");
  const busy = running || reading || exporting || remove.isPending;
  const parsed = parseMaDraft(draft);
  const data = completed ? result.data : null;
  const selectedEntry = history.data?.find((entry) => entry.id === id);
  function changeDraft(next: MaDraft) {
    if (next.symbol !== draft.symbol) {
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
      const source = await utils.maBaselineCoverage.fetch(draft.symbol);
      const from = new Date(`${source.end}T00:00:00Z`);
      from.setUTCDate(from.getUTCDate() - 30);
      setDraft((current) => ({
        ...current,
        start:
          from.toISOString().slice(0, 10) < source.start
            ? source.start
            : from.toISOString().slice(0, 10),
        end: source.end,
      }));
      setCoverage(source);
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
  async function exportResult() {
    setExporting(true);
    setExportError("");
    try {
      const archive = await utils.maBaselineExport.fetch(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(archive)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${archive.manifest.symbol}-${id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice("已生成完整实验 JSON，包含冻结输入、订单和成交。");
    } catch (error) {
      setExportError(
        error instanceof Error ? error.message : "导出失败，请重试。",
      );
    } finally {
      setExporting(false);
    }
  }
  return (
    <Dialog
      open={deleteOpen}
      onOpenChange={(open) => {
        if (!remove.isPending) setDeleteOpen(open);
      }}
    >
      <section className="min-w-0 space-y-4" aria-label="策略回测实验室">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <FlaskConical
                className="size-5 text-nc-accent"
                aria-hidden="true"
              />
              回测实验室
            </h2>
            <p className="mt-1 text-sm text-nc-text-3">
              从一个可复现的实验开始
            </p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="rounded-lg border border-nc-border bg-nc-card px-3 py-2 text-nc-text-2">
              {draft.strategy?.name ?? "双均线 SMA 5 / 20"} · 5分钟
            </span>
            <span className="rounded-lg border border-nc-warn-edge px-3 py-2 text-nc-warn">
              规则自检
            </span>
          </div>
        </header>
        <FactorStrategyEditor
          value={draft.strategy}
          disabled={busy}
          onChange={(strategy) => changeDraft({ ...draft, strategy })}
        />
        <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[19rem_minmax(0,1fr)]">
          <MaExperimentConfig
            draft={draft}
            onChange={changeDraft}
            reading={reading}
            running={running}
            coverage={coverage}
            coverageError={coverageError}
            validationError={parsed.error}
            onReadCoverage={() => void readCoverage()}
            onRun={() => {
              if (parsed.input && !busy) {
                setNotice("");
                setExportError("");
                create.mutate(parsed.input);
              }
            }}
            onCancel={() => {
              if (id) cancel.mutate(id);
            }}
            cancelling={!id || create.isPending || cancel.isPending}
            startDisabled={exporting || remove.isPending}
          />
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
            {completed && result.isLoading && (
              <p
                role="status"
                className="rounded-lg border border-nc-border p-6 text-sm text-nc-text-3"
              >
                正在读取所选实验报告…
              </p>
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
            {data ? (
              <MaExperimentReport
                id={id}
                data={{ ...data, fills: fills.data?.fills ?? [] }}
                modified={!draftMatchesInput(draft, data.summary.input)}
                tab={tab}
                onTabChange={setTab}
                onReuse={() => {
                  setDraft(draftFromInput(data.summary.input));
                  setCoverage(null);
                  setCoverageError("");
                  create.reset();
                  setNotice(
                    "已填入所选实验的原始配置，点击开始回测才会创建新实验。",
                  );
                }}
                onExport={() => void exportResult()}
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
                onDelete={() => remove.reset()}
              />
            ) : (
              !id &&
              !create.isPending && (
                <section
                  aria-label="实验报告空状态"
                  className="flex min-h-80 min-w-0 flex-col items-center justify-center rounded-lg border border-dashed border-nc-border bg-nc-card p-6 text-center"
                >
                  <FlaskConical
                    className="mb-4 size-8 text-nc-accent"
                    aria-hidden="true"
                  />
                  <h3 className="text-base font-medium">准备好第一个实验</h3>
                  <p className="mt-2 max-w-md text-sm leading-relaxed text-nc-text-3">
                    输入证券代码，读取本地覆盖并确认窗口。运行完成后，这里将展示概览、成交与订单和复现依据。
                  </p>
                  <p className="mt-4 text-xs text-nc-text-3">
                    只有真实完成的实验才显示收益和曲线。
                  </p>
                </section>
              )
            )}
            {id && job.data && !running && !data && (
              <DialogTrigger asChild>
                <Button
                  variant="danger"
                  className="min-h-10"
                  onClick={() => remove.reset()}
                >
                  删除实验
                </Button>
              </DialogTrigger>
            )}
          </div>
        </div>
        <MaExperimentHistory
          entries={history.data ?? []}
          selectedId={id}
          disabled={busy}
          loading={history.isFetching}
          error={history.error?.message}
          onSelect={selectExperiment}
          onRefresh={() => void history.refetch()}
        />
        <DialogContent showCloseButton={!remove.isPending}>
          <DialogHeader>
            <DialogTitle>删除所选实验？</DialogTitle>
            <DialogDescription className="break-all">
              {data?.manifest.symbol.toUpperCase() ??
                selectedEntry?.symbol?.toUpperCase() ??
                "双均线实验"}{" "}
              · {id}。删除此任务及其冻结输入和结果，审计事实保留。
            </DialogDescription>
          </DialogHeader>
          {remove.error && (
            <p role="alert" className="text-sm text-nc-bad">
              {remove.error.message}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-10"
              disabled={remove.isPending}
              onClick={() => setDeleteOpen(false)}
            >
              保留实验
            </Button>
            <Button
              variant="danger"
              className="min-h-10"
              disabled={remove.isPending || running || exporting}
              onClick={() => remove.mutate(id)}
            >
              {remove.isPending ? "正在删除…" : "确认删除实验"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </section>
    </Dialog>
  );
}
