import {
  Check,
  LoaderCircle,
  Square,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { TaskHistory } from "../task-history";

import { stamp } from "./shared";
import { type WorkbenchState } from "./use-workbench-state";

export function TaskCenter({
  state,
}: {
  state: Pick<WorkbenchState, "jobs" | "cancel" | "activeJobs">;
}) {
  const { jobs, cancel, activeJobs } = state;
  return (
    <section className="task-bar">
      <div className="panel-title">
        <Workflow size={16} />
        <h3>任务中心</h3>
        <span className="tag">{activeJobs.length} 进行中</span>
      </div>
      <TaskHistory />
      <p className="muted">
        下列为任务摘要；完整阶段与错误可在“全部任务与失败详情”中查看。
      </p>
      {jobs.data?.slice(0, 8).map((j) => (
        <div className="task-row" key={j.id}>
          <span className="task-icon">
            {j.status === "running" ? (
              <LoaderCircle size={14} className="spin" />
            ) : j.status === "completed" ? (
              <Check size={14} />
            ) : j.status === "failed" ? (
              <TriangleAlert size={14} />
            ) : (
              <Square size={12} />
            )}
          </span>
          <strong>
            {
              {
                scan: "数据扫描",
                screen: "条件选股",
                "online-screen": "在线筛选",
                backtest: "策略回测",
                "walk-forward": "滚动检验",
                research: "AI 研究",
                monitor: "策略监控",
              }[j.type]
            }
          </strong>
          <span>
            {j.error ??
              {
                queued: "等待运行",
                running: `${j.phase ?? "进行中"} · ${j.progress}%`,
                completed: "已完成",
                failed: "失败",
                cancelled: "已取消",
              }[j.status]}
          </span>
          <small>{stamp(j.createdAt)}</small>
          {["queued", "running"].includes(j.status) && (
            <button className="text-link" onClick={() => cancel.mutate(j.id)}>
              取消
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
