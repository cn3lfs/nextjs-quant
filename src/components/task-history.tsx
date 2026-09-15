"use client";
import { useState } from "react";
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
  taskStatusLabels,
  taskTypeLabels,
  type TaskState,
} from "~/lib/task-history";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "./ui/select";
import { Button } from "./ui/button";
import { WorkProgressView } from "./screen-task-progress";
import { usePanelVisible } from "./workbench/keep-alive";

type Cursor = { createdAt: number; id: string };
const stamp = (value: number) => new Date(value).toLocaleString("zh-CN");
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
  onOpenScreen,
}: {
  data?: TaskState | null;
  pending: boolean;
  error?: string;
  onRetry: () => void;
  onCancel: () => void;
  cancelling: boolean;
  cancelError?: string;
  onOpenScreen?: (id: string) => void;
}) {
  return (
    <div className="space-y-3 text-sm">
      {pending && <p role="status">正在读取任务详情…</p>}
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
                  {cancelling ? "正在取消…" : "取消任务"}
                </Button>
              )}
            </div>
          </div>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            阶段：{data.phase || "未记录"}
          </p>
          <WorkProgressView counts={data.workProgress} />
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
      {cancelError && <p role="alert">取消失败：{cancelError}</p>}
    </div>
  );
}

export function TaskHistory({
  onOpenScreen,
}: { onOpenScreen?: (id: string) => void } = {}) {
  const [status, setStatus] = useState<TaskState["status"] | "all">("all");
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [selected, setSelected] = useState("");
  const visible = usePanelVisible();
  const utils = api.useUtils();
  const history = api.taskHistory.useQuery(
    { status: status === "all" ? undefined : status, cursor: cursors.at(-1) },
    { refetchOnWindowFocus: false, staleTime: Infinity, retry: false },
  );
  const detail = api.taskState.useQuery(
    { id: selected },
    {
      enabled: visible && !!selected,
      refetchOnWindowFocus: false,
      retry: false,
      refetchInterval: (query) =>
        visible && active(query.state.data?.status ?? "") ? 2000 : false,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: (_data, id) => {
      void utils.taskState.invalidate({ id });
      void utils.taskHistory.invalidate();
      void utils.jobs.invalidate();
    },
  });
  function close() {
    setSelected("");
    if (!cancel.isPending) cancel.reset();
  }
  function refresh() {
    setCursors([undefined]);
    close();
    void utils.taskHistory.invalidate();
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        按创建时间倒序，每页 20 条。点击任务展开详情，再次点击收起。
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
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
      {history.error && (
        <p role="alert">
          任务列表读取失败：{history.error.message}{" "}
          <Button variant="outline" onClick={() => void history.refetch()}>
            重试列表
          </Button>
        </p>
      )}
      {history.isFetching && <p role="status">正在读取任务列表…</p>}
      {history.data && (
        <>
          <p className="text-sm text-muted-foreground">
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
                        if (!cancel.isPending) cancel.reset();
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
                        onCancel={() => cancel.mutate(job.id)}
                        cancelling={cancel.isPending}
                        cancelError={
                          cancel.variables === job.id
                            ? cancel.error?.message
                            : undefined
                        }
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
              {status === "all"
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
