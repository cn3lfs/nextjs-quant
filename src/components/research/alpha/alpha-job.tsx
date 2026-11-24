import { Button } from "~/components/ui/button";
import { activeJobPoll } from "~/components/workbench/job-poll";
import { usePanelVisible } from "~/components/workbench/keep-alive";
import { api } from "~/trpc/react";
import { integer } from "./alpha-format";

export function useAlphaJob<Result>(id: string) {
  const visible = usePanelVisible();
  const task = api.taskState.useQuery(
    { id },
    {
      enabled: visible && Boolean(id),
      refetchInterval: (query) =>
        visible ? activeJobPoll(query.state.data) : false,
    },
  );
  const detail = api.job.useQuery(
    { id },
    {
      enabled: visible && task.data?.status === "completed",
      staleTime: Infinity,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void task.refetch(),
  });
  const status = task.data?.status;
  const running = status === "queued" || status === "running";
  const waiting = Boolean(id) && task.data === undefined;
  const loadingResult = status === "completed" && detail.isPending;
  // The job store has an opaque payload. The submitting mutation owns this job id.
  const result =
    status === "completed"
      ? (detail.data?.result as Result | undefined)
      : undefined;

  return {
    result,
    busy: running || waiting || loadingResult,
    pendingText: running
      ? `${task.data?.phase ?? "等待运行"} · ${integer(task.data?.progress)}%`
      : waiting && !task.error
        ? "正在读取任务状态…"
        : loadingResult
          ? "正在读取结果…"
          : undefined,
    cancelled: status === "cancelled",
    error:
      task.error?.message ??
      detail.error?.message ??
      (task.data === null ? "任务记录不存在" : undefined) ??
      (status === "failed" ? task.data?.error || "任务失败" : undefined) ??
      (status === "completed" && detail.isSuccess && result == null
        ? "任务结果缺失"
        : undefined),
    cancelError: cancel.variables === id ? cancel.error?.message : undefined,
    cancelling: cancel.isPending,
    onCancel: running ? () => cancel.mutate(id) : undefined,
    onRetry: task.error
      ? () => void task.refetch()
      : detail.error
        ? () => void detail.refetch()
        : undefined,
  };
}

export function AlphaJobStatus({
  job,
}: {
  job: ReturnType<typeof useAlphaJob>;
}) {
  return (
    <>
      {job.pendingText && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm text-nc-text-2">
            {job.pendingText}
          </p>
          {job.onCancel && (
            <Button
              size="sm"
              variant="outline"
              disabled={job.cancelling}
              onClick={job.onCancel}
            >
              {job.cancelling ? "正在取消…" : "取消任务"}
            </Button>
          )}
        </div>
      )}
      {job.cancelled && (
        <p role="status" className="text-sm text-nc-text-2">
          任务已取消。
        </p>
      )}
      {job.error && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-nc-up">
            {job.error}
          </p>
          {job.onRetry && (
            <Button size="sm" variant="outline" onClick={job.onRetry}>
              重试读取
            </Button>
          )}
        </div>
      )}
      {job.cancelError && (
        <p role="alert" className="text-sm text-nc-up">
          {job.cancelError}
        </p>
      )}
    </>
  );
}
