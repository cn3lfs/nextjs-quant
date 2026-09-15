import { z } from "zod";
import type { Job } from "./domain";
export const taskStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export const taskHistoryInput = z.object({
  status: taskStatusSchema.optional(),
  cursor: z
    .object({ createdAt: z.number().finite(), id: z.string().min(1).max(200) })
    .optional(),
});
export type TaskState = Pick<
  Job,
  | "id"
  | "type"
  | "status"
  | "progress"
  | "phase"
  | "error"
  | "createdAt"
  | "updatedAt"
  | "workProgress"
  | "attemptId"
  | "auditIncomplete"
> & { resultLink?: { href: string; label: string }; screenResultId?: string };
export const taskTypeLabels: Record<Job["type"], string> = {
  scan: "数据扫描",
  screen: "条件选股",
  "online-screen": "在线筛选",
  backtest: "策略回测",
  "walk-forward": "滚动检验",
  research: "AI 研究",
  monitor: "策略监控",
};
export const taskStatusLabels: Record<Job["status"], string> = {
  queued: "等待运行",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function taskAge(createdAt: number, now = Date.now()) {
  // Compare local calendar days, including across DST and midnight.
  const day = (value: number) => {
    const date = new Date(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  };
  const days = Math.round((day(now) - day(createdAt)) / 86_400_000);
  return days < 0
    ? "未来日期"
    : days === 0
      ? "今天"
      : days === 1
        ? "昨天"
        : `${days} 天前`;
}
