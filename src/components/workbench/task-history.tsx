"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import { useState, useEffect, useRef, type SetStateAction } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  CaretDown as ChevronDown,
  ArrowUpRight,
  ArrowClockwise as RefreshCw,
  CircleNotch as LoaderCircle,
  Warning as TriangleAlert,
  Check,
  Clock,
  Square,
} from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { jobIdPattern } from "~/lib/common/runtime-errors";
import {
  taskAge,
  taskStamp,
  taskStatusLabels,
  taskTypeLabels,
  type TaskState,
} from "~/lib/research/workflow/task-history";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FilterDivider, FilterGroup, FilterToolbar } from "~/components/panels";
import { WorkProgressView } from "../screening/screen-task-progress";
import { useTaskVisible } from "./use-task-visible";
import { TaskEvidence } from "./task-evidence";
import type { RouterOutputs } from "~/trpc/react";
import {
  readTaskHistoryLocation,
  taskHistoryHref,
  type TaskHistoryFilter,
} from "~/lib/research/workflow/task-history-location";
import {
  useTaskHistorySession,
  useTaskSession,
} from "~/lib/stores/task-history-session";

const stamp = taskStamp;
const active = (status: string) => status === "running" || status === "queued";
const statusIcons = {
  queued: Clock,
  running: LoaderCircle,
  completed: Check,
  failed: TriangleAlert,
  cancelled: Square,
};

export function TaskDetails({
  data,
  pending,
  error,
  onRetry,
  onCancel,
  cancelling,
  cancelError,
  cancelNotice,
  onViewErrors,
}: {
  data?: TaskState | null;
  pending: boolean;
  error?: string;
  onRetry: () => void;
  onCancel: () => void;
  cancelling: boolean;
  cancelError?: string;
  cancelNotice?: string;
  onViewErrors?: (id: string) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      {pending && !data && <p role="status">正在读取任务详情…</p>}
      {error && (
        <p role="alert">
          读取失败：{error}{" "}
          <Button variant="outline" size="sm" onClick={onRetry}>
            重试详情
          </Button>
        </p>
      )}
      {data === null && <p>任务不存在，可能已被清理。请刷新任务列表。</p>}
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong>
              {taskStatusLabels[data.status]} · {data.progress}%
            </strong>
            <div className="flex flex-wrap gap-2">
              {data.resultLink && (
                <Button asChild variant="outline" size="sm">
                  <Link href={data.resultLink.href} prefetch={false}>
                    {data.resultLink.label}
                    <ArrowUpRight size={14} />
                  </Link>
                </Button>
              )}
              {data.screenResultId && (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/scan?tab=formula&job=${encodeURIComponent(data.screenResultId)}`}
                    prefetch={false}
                  >
                    {data.type === "research"
                      ? "查看选股与快评结果"
                      : "查看选股结果"}
                    <ArrowUpRight size={14} />
                  </Link>
                </Button>
              )}
              {!active(data.status) && data.sourceLink && (
                <Button asChild variant="outline" size="sm">
                  <Link href={data.sourceLink.href} prefetch={false}>
                    {data.sourceLink.label}
                  </Link>
                </Button>
              )}
              {!error && onViewErrors && jobIdPattern.test(data.id) && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onViewErrors(data.id)}
                >
                  查看此任务的最近错误
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={onRetry}
              >
                刷新详情
              </Button>
              {active(data.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={cancelling}
                  onClick={onCancel}
                >
                  {cancelling ? "正在提交取消…" : "取消任务"}
                </Button>
              )}
            </div>
          </div>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            阶段：{data.phase || "未记录"}
          </p>
          <WorkProgressView counts={data.workProgress} />
          {data.localEvidence && data.status === "completed" && (
            <TaskEvidence id={data.id} />
          )}
          {!active(data.status) && !data.sourceLink && (
            <p className="text-muted-foreground">
              未记录可确认的来源入口，请回到原功能页核对参数后重新发起。
            </p>
          )}
          {data.sourceLink && !active(data.status) && (
            <p className="text-muted-foreground">
              跳转只打开来源页，不会自动填入原参数或启动任务。
            </p>
          )}
          {data.status === "cancelled" && (
            <p className="text-muted-foreground">
              已标记取消；不代表外部请求已撤回或执行资源已全部释放。
            </p>
          )}
          {data.error && (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive"
            >
              <strong>失败原因</strong>
              <p
                tabIndex={0}
                aria-label="完整错误"
                className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]"
              >
                {data.error}
              </p>
            </div>
          )}
          {data.auditIncomplete && (
            <p role="alert">
              审计记录未完整保存，不能按完整研究记录使用；请在研究使用台账核对本次尝试。
            </p>
          )}
          <dl className="grid gap-x-8 gap-y-2 text-muted-foreground lg:grid-cols-2">
            <div>
              <dt>创建时间</dt>
              <dd>{stamp(data.createdAt)}</dd>
            </div>
            <div>
              <dt>最后更新</dt>
              <dd>{stamp(data.updatedAt)}</dd>
            </div>
            <div>
              <dt>{active(data.status) ? "已等待 / 运行" : "总历时"}</dt>
              <dd>
                {formatNumber(
                  Math.max(
                    0,
                    ((active(data.status) ? Date.now() : data.updatedAt) -
                      data.createdAt) /
                      1000,
                  ),
                  2,
                )}{" "}
                秒
              </dd>
            </div>
            <div className="[overflow-wrap:anywhere]">
              <dt>任务编号</dt>
              <dd>{data.id}</dd>
            </div>
            {data.attemptId && (
              <div className="[overflow-wrap:anywhere]">
                <dt>研究尝试</dt>
                <dd>{data.attemptId}</dd>
              </div>
            )}
          </dl>
        </>
      )}
      {cancelNotice && <p role="status">{cancelNotice}</p>}
      {cancelError && <p role="alert">取消失败：{cancelError}</p>}
    </div>
  );
}

export function TaskHistory({
  overview,
  refreshOverview,
  onViewErrors,
}: {
  overview?: RouterOutputs["taskOverview"];
  refreshOverview?: () => void;
  onViewErrors?: (id: string) => void;
} = {}) {
  const search = useSearchParams();
  const location = readTaskHistoryLocation(search.toString());
  const { filter } = location;
  const status = filter.status ?? "all",
    type = filter.type ?? "all",
    id = filter.id ?? "";
  // A detail intent carries both the applied filter and the exact identifier;
  // any other location changes the key so a stale selection cannot stay active.
  const detailIntent = location.detailId
    ? `${taskHistoryHref(filter)}\u0000${location.detailId}`
    : null;
  const selectionKey = detailIntent ?? taskHistoryHref(filter);
  const session = useTaskHistorySession(filter);
  const { statusDraft, typeDraft, idDraft, cursors } = session;
  const setCursors = (value: SetStateAction<typeof cursors>) =>
    session.update("cursors", value);
  const [selection, setSelection] = useState<{
    key: string;
    id: string;
  } | null>(null);
  // Any location change drops the stored selection during render, so returning
  // to a previously opened URL cannot resurrect it ahead of the fresh intent.
  const selectionKeyRef = useRef(selectionKey);
  if (selectionKeyRef.current !== selectionKey) {
    selectionKeyRef.current = selectionKey;
    if (selection) setSelection(null);
  }
  const selected = selection?.key === selectionKey ? selection.id : "";
  const [notice, setNotice] = useState("");
  // Consumption follows the URL intent, not fetches: a successful read opens or
  // resolves it once, while leaving the intent lets Back/Forward request it again.
  const trackedIntent = useRef<string | null>(null);
  const handledIntent = useRef<string | null>(null);
  const suppressedIntent = useRef<string | null>(null);
  const cancelStates = useTaskSession((state) => state.cancellations);
  const { beginCancel, finishCancel } = useTaskSession.getState();
  const title = useRef<HTMLParagraphElement>(null);
  const seenRevision = useRef<number | undefined>(undefined);
  const [seenTotal, setSeenTotal] = useState<number | undefined>(undefined);
  const visible = useTaskVisible();
  const utils = api.useUtils();
  const input = {
    status: status === "all" ? undefined : status,
    type: type === "all" ? undefined : type,
    id: id || undefined,
    cursor: cursors.at(-1),
  };
  const history = api.taskHistory.useQuery(input, {
    enabled: visible && !location.error,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  const detail = api.taskState.useQuery(
    { id: selected },
    {
      enabled: visible && !location.error && !!selected,
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: false,
      refetchInterval: (query) =>
        visible && !location.error && active(query.state.data?.status ?? "")
          ? 2000
          : false,
    },
  );
  // A job revision includes older active jobs outside the recent-results window.
  useEffect(() => {
    if (!visible || location.error || overview == null) return;
    if (
      seenRevision.current !== undefined &&
      seenRevision.current !== overview.revision
    )
      void utils.taskHistory.invalidate(input);
    seenRevision.current = overview.revision;
    setSeenTotal((value) => value ?? overview.total);
  }, [visible, overview?.revision]); // Query filters fetch through their own key.
  useEffect(() => {
    if (trackedIntent.current === detailIntent) return;
    // Entering any location (including another detail link) starts a fresh
    // one-time intent; only staying on the same location keeps it consumed.
    trackedIntent.current = detailIntent;
    handledIntent.current = null;
    suppressedIntent.current = null;
  }, [detailIntent]);
  useEffect(() => {
    const detailId = location.detailId;
    if (!detailId || !detailIntent || handledIntent.current === detailIntent)
      return;
    if (!visible || location.error) return;
    // Cached rows must wait for this observer's own fetch to settle, so a
    // pending refresh cannot be mistaken for a confirmed active query.
    if (
      !history.isFetchedAfterMount ||
      history.isFetching ||
      history.error ||
      !history.data
    )
      return;
    // The active filter query has settled: this intent is consumed even when it
    // finds nothing or the user already collapsed the row on their own.
    handledIntent.current = detailIntent;
    const { total, items } = history.data;
    if (
      suppressedIntent.current === detailIntent ||
      total !== 1 ||
      items.length !== 1 ||
      items[0]?.id !== detailId
    )
      return;
    setSelection((current) =>
      current?.key === selectionKey && current.id === detailId
        ? current
        : { key: selectionKey, id: detailId },
    );
  }, [
    detailIntent,
    selectionKey,
    visible,
    location.error,
    location.detailId,
    history.isFetchedAfterMount,
    history.isFetching,
    history.error,
    history.data,
  ]);
  useEffect(() => {
    if (
      selected &&
      history.data &&
      !history.isFetching &&
      !history.error &&
      !history.data.items.some((item) => item.id === selected)
    ) {
      setSelection(null);
      setNotice("所选任务已不在当前页或筛选结果中。");
      title.current?.focus();
    }
  }, [selected, history.data, history.isFetching, history.error]);
  const cancel = api.cancel.useMutation();
  async function cancelTask(taskId: string) {
    if (!beginCancel(taskId)) return;
    try {
      const result = await cancel.mutateAsync(taskId);
      const messages = {
        accepted: "取消已受理；不撤销已经发生的外部请求。",
        "already-cancelled": "任务已标记取消。",
        "already-terminal": "任务已经结束，保留实际最终状态。",
        "not-found": "任务不存在，请刷新列表。",
      };
      finishCancel(taskId, { notice: messages[result.outcome] });
      void utils.taskState.invalidate({ id: taskId });
      void utils.taskHistory.invalidate(input);
      void utils.taskOverview.invalidate();
      void utils.jobs.invalidate();
    } catch (error) {
      finishCancel(taskId, {
        error: error instanceof Error ? error.message : "请求失败",
      });
    }
  }
  function close() {
    setSelection(null);
    setNotice("");
  }
  function applyFilter(next: TaskHistoryFilter) {
    session.reset(next);
    close();
    window.history.pushState(null, "", taskHistoryHref(next));
  }
  function refresh() {
    if (location.error) return;
    void history.refetch();
    if (selected) void detail.refetch();
    refreshOverview?.();
  }
  function latest() {
    if (location.error) return;
    setCursors([undefined]);
    close();
    setSeenTotal(overview?.total);
    void utils.taskHistory.invalidate({ ...input, cursor: undefined });
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        按创建时间倒序，每页 20
        条；时间均为北京时间。点击任务展开详情，再次点击收起。
      </p>
      <FilterToolbar label="任务筛选">
        <form
          className="flex min-w-0 flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            applyFilter({
              status: statusDraft === "all" ? undefined : statusDraft,
              type: typeDraft === "all" ? undefined : typeDraft,
              id: idDraft.trim() || undefined,
            });
          }}
        >
          <FilterGroup label="状态">
            <Select
              value={statusDraft}
              onValueChange={(value) =>
                session.update("statusDraft", value as typeof statusDraft)
              }
            >
              <SelectTrigger
                size="sm"
                aria-label="历史任务状态"
                className="w-36"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                {Object.entries(taskStatusLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterGroup>
          <FilterGroup label="类型">
            <Select
              value={typeDraft}
              onValueChange={(value) =>
                session.update("typeDraft", value as typeof typeDraft)
              }
            >
              <SelectTrigger size="sm" aria-label="任务类型" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部类型</SelectItem>
                {Object.entries(taskTypeLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterGroup>
          <FilterGroup>
            <Input
              aria-label="精确任务编号"
              placeholder="输入完整任务编号"
              maxLength={200}
              value={idDraft}
              onChange={(event) =>
                session.update("idDraft", event.target.value)
              }
              className="h-8 w-48"
            />
            <Button type="submit" variant="outline" size="sm">
              查询任务
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => applyFilter({})}
            >
              清除筛选
            </Button>
          </FilterGroup>
        </form>
        <FilterDivider />
        <Button
          variant="outline"
          size="sm"
          disabled={history.isFetching || !!location.error}
          onClick={refresh}
        >
          <RefreshCw size={14} />
          刷新任务
        </Button>
      </FilterToolbar>
      {location.error && <p role="alert">{location.error}</p>}
      {!location.error && (
        <p className="text-sm text-muted-foreground" role="status">
          已应用：{status === "all" ? "全部状态" : taskStatusLabels[status]} ·{" "}
          {type === "all" ? "全部类型" : taskTypeLabels[type]}
          {id ? ` · 编号 ${id}` : ""}
          {statusDraft !== status || typeDraft !== type || idDraft.trim() !== id
            ? "；有未应用条件，请查询。"
            : ""}
        </p>
      )}
      {!location.error &&
        (cursors.length > 1 ||
          (overview && seenTotal != null && overview.total > seenTotal)) && (
          <Button variant="outline" onClick={latest}>
            {overview && seenTotal != null && overview.total > seenTotal
              ? "有新任务，回到最新"
              : "回到最新"}
          </Button>
        )}
      {notice && <p role="status">{notice}</p>}
      {!location.error && history.dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground">
          列表更新于 {stamp(history.dataUpdatedAt)}
          {history.error ? "；当前为上次读取的数据，尚未刷新。" : ""}
        </p>
      )}
      {!location.error && history.error && (
        <p role="alert">
          任务列表读取失败：{history.error.message}{" "}
          <Button variant="outline" onClick={() => void history.refetch()}>
            重试列表
          </Button>
        </p>
      )}
      {!location.error && history.isFetching && !history.data && (
        <p role="status">正在读取任务列表…</p>
      )}
      {!location.error && history.data && (
        <>
          <p
            ref={title}
            tabIndex={-1}
            className="text-sm text-muted-foreground"
          >
            共 {history.data.total} 条 · 第 {cursors.length} 页
          </p>
          <div aria-label="任务列表" className="space-y-2">
            {history.data.items.map((summary) => {
              const expanded = selected === summary.id;
              const job = expanded && detail.data ? detail.data : summary;
              const Icon = statusIcons[job.status];
              const panelId = `task-detail-${job.id}`;
              const triggerId = `task-trigger-${job.id}`;
              return (
                <article
                  key={job.id}
                  className={`overflow-hidden rounded-lg border ${expanded ? "border-primary/40 bg-card" : "border-border bg-card"}`}
                >
                  <h4 className="m-0!">
                    <Button
                      variant="plain"
                      id={triggerId}
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => {
                        // A manual collapse during an unconsumed intent wins
                        // over the automatic open that may still arrive.
                        if (expanded && detailIntent)
                          suppressedIntent.current = detailIntent;
                        setSelection(
                          expanded ? null : { key: selectionKey, id: job.id },
                        );
                        setNotice("");
                      }}
                      className="flex w-full items-start gap-3 p-4 text-left hover:bg-muted/40"
                    >
                      <Icon
                        size={16}
                        aria-hidden="true"
                        className={`mt-1 shrink-0 ${job.status === "failed" ? "text-destructive" : "text-primary"} ${job.status === "running" ? "motion-safe:animate-spin" : ""}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <strong>{taskTypeLabels[job.type]}</strong>
                          <span
                            className={`rounded-md px-2 py-0.5 text-xs ${job.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}
                          >
                            {taskStatusLabels[job.status]}
                          </span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {job.progress}%
                          </span>
                        </span>
                        <span className="mt-1 block truncate text-sm font-normal text-muted-foreground">
                          {job.error || job.phase || "未记录阶段"}
                        </span>
                        <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-muted-foreground">
                          <span>
                            {taskAge(job.createdAt)} · {stamp(job.createdAt)}
                          </span>
                          <span>编号 {job.id.slice(-8)}</span>
                          {job.auditIncomplete && (
                            <span className="text-destructive">
                              审计记录不完整
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                        <span className="hidden lg:inline">
                          {expanded ? "收起" : "详情"}
                        </span>
                        <ChevronDown
                          size={16}
                          aria-hidden="true"
                          className={expanded ? "rotate-180" : ""}
                        />
                      </span>
                    </Button>
                  </h4>
                  <section
                    id={panelId}
                    aria-labelledby={triggerId}
                    hidden={!expanded}
                    className="border-t border-border bg-muted/20 p-4 lg:px-11"
                  >
                    {expanded && (
                      <TaskDetails
                        data={detail.data}
                        pending={detail.isFetching}
                        error={detail.error?.message}
                        onRetry={() => void detail.refetch()}
                        onCancel={() => void cancelTask(job.id)}
                        cancelling={!!cancelStates[job.id]?.pending}
                        cancelError={cancelStates[job.id]?.error}
                        cancelNotice={cancelStates[job.id]?.notice}
                        onViewErrors={onViewErrors}
                      />
                    )}
                  </section>
                </article>
              );
            })}
          </div>
          {history.data.items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
              {location.detailId && !history.error ? (
                <>
                  没有找到编号 {location.detailId} 的任务。
                  {status !== "all" || type !== "all"
                    ? "当前的状态或类型筛选也会影响结果，可清除筛选后重试。"
                    : ""}
                </>
              ) : status === "all" && type === "all" && !id ? (
                "暂无任务。扫描数据、运行选股或发起研究后，可在这里查看。"
              ) : (
                "没有符合该状态的任务。可切换为全部查看。"
              )}
            </div>
          )}
          <nav
            aria-label="任务分页"
            className="flex items-center justify-between gap-3"
          >
            <Button
              variant="outline"
              disabled={cursors.length === 1 || history.isFetching}
              onClick={() => {
                setCursors((p) => p.slice(0, -1));
                close();
              }}
            >
              上一页任务
            </Button>
            <Button
              variant="outline"
              disabled={!history.data.nextCursor || history.isFetching}
              onClick={() => {
                if (history.data?.nextCursor)
                  setCursors((p) => [...p, history.data!.nextCursor!]);
                close();
              }}
            >
              下一页任务
            </Button>
          </nav>
        </>
      )}
    </div>
  );
}
