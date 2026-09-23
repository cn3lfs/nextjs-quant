import { ListChecks, Queue } from "@phosphor-icons/react/ssr";
import { TaskHistory } from "../common/task-history";
import { PageGrid, Panel, StatsPanel } from "../panels";
import { type WorkbenchState } from "./use-workbench-state";

export function TaskCenter({
  state,
}: {
  state: Pick<WorkbenchState, "selectFormulaJob" | "setTab" | "jobs">;
}) {
  return (
    <PageGrid>
      <StatsPanel
        icon={ListChecks}
        title="队列"
        meta="最近 80 个任务"
        items={queueStats(state.jobs.data ?? [])}
      />
      <Panel
        icon={Queue}
        title="全部任务"
        note="退出应用会中止运行中的任务，可在此重新发起。"
      >
        <TaskHistory
          onOpenScreen={(id) => {
            state.selectFormulaJob(id);
            state.setTab("screen");
          }}
        />
      </Panel>
    </PageGrid>
  );
}

const day = (at: number) =>
  new Date(at + 8 * 3600000).toISOString().slice(0, 10);

/** Queue counts from the recent job summaries the workbench already polls. */
export function queueStats(
  jobs: readonly { status: string; updatedAt?: number; createdAt: number }[],
  now = Date.now(),
) {
  const count = (status: string) =>
    jobs.filter((job) => job.status === status).length;
  const failed = count("failed");
  return [
    {
      label: "运行中",
      value: count("running"),
      tone: count("running") ? ("accent" as const) : ("neutral" as const),
    },
    { label: "排队", value: count("queued") },
    {
      label: "今日完成",
      value: jobs.filter(
        (job) =>
          job.status === "completed" &&
          day(job.updatedAt ?? job.createdAt) === day(now),
      ).length,
    },
    {
      label: "失败",
      value: failed,
      note: failed ? "展开任务查看原因" : undefined,
      tone: failed ? ("bad" as const) : ("neutral" as const),
    },
    { label: "已取消", value: count("cancelled"), tone: "idle" as const },
  ];
}
