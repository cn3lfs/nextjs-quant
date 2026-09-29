"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  ChevronDown,
  ArrowUpRight,
  RefreshCw,
  LoaderCircle,
  TriangleAlert,
  Check,
  Clock,
  Square,
} from "lucide-react";
import { api } from "~/trpc/react";
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
import { WorkProgressView } from "../screening/screen-task-progress";
import { useTaskVisible } from "./use-task-visible";
import type { RouterOutputs } from "~/trpc/react";

type Cursor = { createdAt: number; id: string };
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
  onOpenScreen,
}: {
  data?: TaskState | null;
  pending: boolean;
  error?: string;
  onRetry: () => void;
  onCancel: () => void;
  cancelling: boolean;
  cancelError?: string;
  cancelNotice?: string;
  onOpenScreen?: (id: string) => void;
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
              {data.screenResultId && onOpenScreen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenScreen(data.screenResultId!)}
                >
                  {data.type === "research"
                    ? "查看选股与快评结果"
                    : "查看选股结果"}
                  <ArrowUpRight size={14} />
                </Button>
              )}
              {!active(data.status) && data.sourceLink && (
                <Button asChild variant="outline" size="sm">
                  <Link href={data.sourceLink.href} prefetch={false}>
                    {data.sourceLink.label}
                  </Link>
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
          <dl className="grid gap-x-8 gap-y-2 text-muted-foreground sm:grid-cols-2">
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
                {Math.max(
                  0,
                  ((active(data.status) ? Date.now() : data.updatedAt) -
                    data.createdAt) /
                    1000,
                ).toFixed(2)}{" "}
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
  onOpenScreen,
  overview,
  refreshOverview,
}: {
  onOpenScreen?: (id: string) => void;
  overview?: RouterOutputs["taskOverview"];
  refreshOverview?: () => void;
} = {}) {
  const [status, setStatus] = useState<TaskState["status"] | "all">("all");
  const [type, setType] = useState<TaskState["type"] | "all">("all");
  const [idDraft, setIdDraft] = useState("");
  const [id, setId] = useState("");
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState("");
  const [cancelStates, setCancelStates] = useState<
    Record<string, { pending?: boolean; error?: string; notice?: string }>
  >({});
  const inFlight = useRef(new Set<string>());
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
    enabled: visible,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  const detail = api.taskState.useQuery(
    { id: selected },
    {
      enabled: visible && !!selected,
      staleTime: 0,
      refetchOnWindowFocus: true,
      retry: false,
      refetchInterval: (query) =>
        visible && active(query.state.data?.status ?? "") ? 2000 : false,
    },
  );
  // A job revision includes older active jobs, unlike the sidebar's recent-80 window.
  useEffect(() => {
    if (!visible || overview == null) return;
    if (
      seenRevision.current !== undefined &&
      seenRevision.current !== overview.revision
    )
      void utils.taskHistory.invalidate(input);
    seenRevision.current = overview.revision;
    setSeenTotal((value) => value ?? overview.total);
  }, [visible, overview?.revision]); // Query filters fetch through their own key.
  useEffect(() => {
    if (
      selected &&
      history.data &&
      !history.isFetching &&
      !history.error &&
      !history.data.items.some((item) => item.id === selected)
    ) {
      setSelected("");
      setNotice("所选任务已不在当前页或筛选结果中。");
      title.current?.focus();
    }
  }, [selected, history.data, history.isFetching, history.error]);
  const cancel = api.cancel.useMutation();
  async function cancelTask(taskId: string) {
    if (inFlight.current.has(taskId)) return;
    inFlight.current.add(taskId);
    setCancelStates((value) => ({ ...value, [taskId]: { pending: true } }));
    try {
      const result = await cancel.mutateAsync(taskId);
      const messages = {
        accepted: "取消已受理；不撤销已经发生的外部请求。",
        "already-cancelled": "任务已标记取消。",
        "already-terminal": "任务已经结束，保留实际最终状态。",
        "not-found": "任务不存在，请刷新列表。",
      };
      setCancelStates((value) => ({
        ...value,
        [taskId]: { notice: messages[result.outcome] },
      }));
      void utils.taskState.invalidate({ id: taskId });
      void utils.taskHistory.invalidate(input);
      void utils.taskOverview.invalidate();
      void utils.jobs.invalidate();
    } catch (error) {
      setCancelStates((value) => ({
        ...value,
        [taskId]: {
          error: error instanceof Error ? error.message : "请求失败",
        },
      }));
    } finally {
      inFlight.current.delete(taskId);
    }
  }
  function close() {
    setSelected("");
    setNotice("");
  }
  function refresh() {
    void history.refetch();
    if (selected) void detail.refetch();
    refreshOverview?.();
  }
  function latest() {
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm">任务状态</span>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as typeof status);
              setCursors([undefined]);
              close();
            }}
          >
            <SelectTrigger aria-label="历史任务状态">
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
          <Select
            value={type}
            onValueChange={(value) => {
              setType(value as typeof type);
              setCursors([undefined]);
              close();
            }}
          >
            <SelectTrigger aria-label="任务类型">
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
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setId(idDraft.trim());
              setCursors([undefined]);
              close();
            }}
          >
            <Input
              aria-label="精确任务编号"
              placeholder="输入完整任务编号"
              maxLength={200}
              value={idDraft}
              onChange={(event) => setIdDraft(event.target.value)}
              className="min-w-0 rounded-md border border-input bg-background px-3 py-2 text-sm"
            />
            <Button type="submit" variant="outline">
              查找
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setIdDraft("");
                setId("");
                setStatus("all");
                setType("all");
                setCursors([undefined]);
                close();
              }}
            >
              清除筛选
            </Button>
          </form>
        </div>
        <Button
          variant="outline"
          disabled={history.isFetching}
          onClick={refresh}
        >
          <RefreshCw size={14} />
          刷新任务
        </Button>
      </div>
      {(cursors.length > 1 ||
        (overview && seenTotal != null && overview.total > seenTotal)) && (
        <Button variant="outline" onClick={latest}>
          {overview && seenTotal != null && overview.total > seenTotal
            ? "有新任务，回到最新"
            : "回到最新"}
        </Button>
      )}
      {notice && <p role="status">{notice}</p>}
      {history.dataUpdatedAt > 0 && (
        <p className="text-xs text-muted-foreground">
          列表更新于 {stamp(history.dataUpdatedAt)}
          {history.error ? "；当前为上次读取的数据，尚未刷新。" : ""}
        </p>
      )}
      {history.error && (
        <p role="alert">
          任务列表读取失败：{history.error.message}{" "}
          <Button variant="outline" onClick={() => void history.refetch()}>
            重试列表
          </Button>
        </p>
      )}
      {history.isFetching && !history.data && (
        <p role="status">正在读取任务列表…</p>
      )}
      {history.data && (
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
                        setSelected(expanded ? "" : job.id);
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
                        <span className="hidden sm:inline">
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
                    className="border-t border-border bg-muted/20 p-4 sm:px-11"
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
                        onOpenScreen={onOpenScreen}
                      />
                    )}
                  </section>
                </article>
              );
            })}
          </div>
          {history.data.items.length === 0 && (
            <div className="rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
              {status === "all" && type === "all" && !id
                ? "暂无任务。扫描数据、运行选股或发起研究后，可在这里查看。"
                : "没有符合该状态的任务。可切换为全部查看。"}
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
