"use client";
import { api } from "~/trpc/react";
import { taskStatusLabels, type TaskState } from "~/lib/research/workflow/task-history";
import type { WorkProgress } from "~/lib/research/workflow/work-progress";
export function WorkProgressView({ counts }: { counts?: WorkProgress }) {
  return counts ? (
    <p>
      计数阶段：{counts.stage} · 已处理 {counts.processed}/{counts.total}{" "}
      {counts.unit} · 本阶段失败 {counts.failed} · 隔离 {counts.excluded}
    </p>
  ) : (
    <p className="muted">尚无阶段计数；旧任务未记录此项。</p>
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
        [q.state.data?.rule, q.state.data?.research].some(
          (task) => task && ["queued", "running"].includes(task.status),
        )
          ? 2000
          : false,
    },
  );
  if (state.error)
    return <p role="alert">进度读取失败：{state.error.message}</p>;
  if (!state.data) return null;
  return (
    <section aria-label="规则与AI独立进度">
      <p>规则结果完成即可查看；AI 快评在独立任务中执行。</p>
      <div className="form-grid">
        <TaskProgressCard title="规则筛选" task={state.data.rule} />
        {state.data.research ? (
          <TaskProgressCard title="AI 快评" task={state.data.research} />
        ) : (
          <div>
            <strong>AI 快评</strong>
            <p>本次规则任务尚未创建自动快评任务。</p>
          </div>
        )}
      </div>
    </section>
  );
}
