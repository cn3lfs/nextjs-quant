"use client";
import { api } from "~/trpc/react";
import {
  taskStatusLabels,
  type TaskState,
} from "~/lib/research/workflow/task-history";
import type { WorkProgress } from "~/lib/research/workflow/work-progress";
export function WorkProgressView({ counts }: { counts?: WorkProgress }) {
  return counts ? (
    <p>
      计数阶段：{counts.stage} · 已处理 {counts.processed}/{counts.total}{" "}
      {counts.unit} · 本阶段失败 {counts.failed} · 隔离 {counts.excluded}
    </p>
  ) : (
    <p className="muted">尚无阶段计数。</p>
  );
}
function TaskProgressCard({ title, task }: { title: string; task: TaskState }) {
  return (
    <div>
      <strong>
        {title} · {taskStatusLabels[task.status]}
      </strong>
      <p>
        {task.phase || "未记录阶段"} · {task.progress}%
      </p>
      <WorkProgressView counts={task.workProgress} />
      <p>
        总历时（含排队）{" "}
        {Math.max(
          0,
          ((["queued", "running"].includes(task.status)
            ? Date.now()
            : task.updatedAt) -
            task.createdAt) /
            1000,
        ).toFixed(2)}{" "}
        秒
      </p>
      {task.error && <p role="alert">{task.error}</p>}
    </div>
  );
}
export function ScreenTaskProgress({ id }: { id: string }) {
  const state = api.screenTaskProgress.useQuery(
    { id },
    {
      enabled: !!id,
      refetchInterval: (q) =>
        q.state.data && ["queued", "running"].includes(q.state.data.status)
          ? 2000
          : false,
    },
  );
  if (state.error)
    return <p role="alert">进度读取失败：{state.error.message}</p>;
  if (!state.data) return null;
  return (
    <section aria-label="公式选股进度">
      <TaskProgressCard title="公式筛选" task={state.data} />
    </section>
  );
}
