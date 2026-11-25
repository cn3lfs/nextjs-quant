"use client";
import { useEffect, useSyncExternalStore } from "react";
import { api, type RouterOutputs } from "~/trpc/react";
import { Button } from "../ui/button";

type MarketPanelJob = RouterOutputs["marketPanelStatus"]["job"];

function runningJobId(job: MarketPanelJob | undefined) {
  return job?.status === "queued" || job?.status === "running" ? job.id : null;
}

type BuildTracking = {
  submitting: boolean;
  activeJobId: string | null;
  lastFailedJobId: string | null;
  lastFailedMessage: string | null;
};

const initialTracking: BuildTracking = {
  submitting: false,
  activeJobId: null,
  lastFailedJobId: null,
  lastFailedMessage: null,
};
let tracking = initialTracking;
const listeners = new Set<() => void>();
const invalidatedJobIds = new Set<string>();
let lastRefreshedSnapshotId: string | null = null;
const failedMessage = "面板未生成成功，请检查本机通达信数据后重试";

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function updateTracking(update: Partial<BuildTracking>) {
  tracking = { ...tracking, ...update };
  listeners.forEach((listener) => listener());
}

export function MarketPanelBuildAction({
  hasPanel,
  visible,
}: {
  hasPanel: boolean;
  visible: boolean;
}) {
  const utils = api.useUtils();
  const { submitting, activeJobId, lastFailedMessage } = useSyncExternalStore(
    subscribe,
    () => tracking,
    () => initialTracking,
  );

  const mutation = api.marketPanelBuild.useMutation({
    onSuccess: ({ jobId }) =>
      updateTracking({ submitting: false, activeJobId: jobId }),
    onError: () =>
      updateTracking({ submitting: false, lastFailedMessage: failedMessage }),
  });
  const status = api.marketPanelStatus.useQuery(
    { jobId: activeJobId ?? undefined },
    {
      enabled: visible,
      staleTime: 0,
      refetchInterval: (query) => {
        const job = query.state.data?.job;
        if (activeJobId !== null && job?.id !== activeJobId) return 2000;
        return runningJobId(job) !== null ? 2000 : false;
      },
      retry: false,
    },
  );

  const job = status.data?.job;
  const trackedJob = job?.id === activeJobId ? job : undefined;
  const busy = submitting || activeJobId !== null;
  const ready = status.data?.ready === true;
  const snapshotId = status.data?.snapshotId;
  const { isFetching, isSuccess } = status;
  useEffect(() => {
    if (!visible || tracking.submitting || tracking.activeJobId !== activeJobId)
      return;

    const runningId = runningJobId(job);
    let completedJobId: string | undefined;
    if (activeJobId === null) {
      if (isFetching || !isSuccess) return;
      if (runningId !== null) {
        if (
          runningId !== tracking.lastFailedJobId &&
          !invalidatedJobIds.has(runningId)
        ) {
          updateTracking({
            activeJobId: runningId,
            lastFailedJobId: null,
            lastFailedMessage: null,
          });
        }
        return;
      }
      // A panel can also be published outside this action.
      if (hasPanel || !ready || !snapshotId) return;
      if (job?.status === "completed" && job.snapshotId === snapshotId) {
        completedJobId = job.id;
      } else if (snapshotId === lastRefreshedSnapshotId) return;
    } else {
      if (job?.id !== activeJobId || runningId !== null) return;
      if (job.status !== "completed") {
        updateTracking({
          activeJobId: null,
          lastFailedJobId: job.id,
          lastFailedMessage:
            job.status === "cancelled" ? "构建已取消，可重试" : failedMessage,
        });
        return;
      }
      completedJobId = job.id;
      updateTracking({ activeJobId: null });
    }

    if (completedJobId !== undefined) {
      if (invalidatedJobIds.has(completedJobId)) return;
      invalidatedJobIds.add(completedJobId);
    }
    if (snapshotId) lastRefreshedSnapshotId = snapshotId;
    void utils.marketTemperature.invalidate();
    void utils.industryRotationRrg.invalidate();
  }, [
    activeJobId,
    hasPanel,
    isFetching,
    isSuccess,
    job,
    ready,
    snapshotId,
    submitting,
    utils,
    visible,
  ]);

  if (!visible || (hasPanel && !busy && lastFailedMessage === null))
    return null;

  const phase = submitting
    ? "正在提交构建任务…"
    : trackedJob?.phase.trim() || "排队中";
  const title = busy
    ? trackedJob
      ? `${phase} (${trackedJob.progress}%)`
      : phase
    : "按本机通达信日线生成市场温度与行业轮动所需的冻结面板";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        type="button"
        size="sm"
        variant={busy ? "outline" : "default"}
        disabled={busy}
        title={title}
        onClick={() => {
          if (tracking.submitting || tracking.activeJobId !== null) return;
          updateTracking({
            submitting: true,
            lastFailedJobId: null,
            lastFailedMessage: null,
          });
          mutation.mutate();
        }}
      >
        {busy ? "构建中…" : "生成冻结面板"}
      </Button>
      {!busy && lastFailedMessage !== null && (
        <span
          className="text-[12px] text-nc-warn"
          role="status"
          title="详细原因已写入本机运行日志，不在此处展示路径信息"
        >
          {lastFailedMessage}
        </span>
      )}
    </span>
  );
}
