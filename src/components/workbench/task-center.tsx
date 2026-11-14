"use client";
import { ListChecks, Queue } from "@phosphor-icons/react/ssr";
import { TaskHistory } from "./task-history";
import { PageGrid, Panel, StatsPanel } from "../panels";
import { taskStamp } from "~/lib/research/workflow/task-history";
import { useTaskOverview } from "./use-task-overview";
import { Button } from "../ui/button";
import { RecentErrors } from "./recent-errors";

export function TaskCenter() {
  const overview = useTaskOverview();
  const counts = overview.data;
  return (
    <PageGrid>
      <StatsPanel
        icon={ListChecks}
        title="任务概览"
        meta="全部已记录任务 · 北京时间"
        items={[
          {
            label: "运行中",
            value: counts?.running ?? "—",
            tone: counts?.running ? "accent" : "neutral",
          },
          { label: "等待运行", value: counts?.queued ?? "—" },
          { label: "今日完成", value: counts?.completedToday ?? "—" },
          {
            label: "历史失败",
            value: counts?.failed ?? "—",
            tone: counts?.failed ? "bad" : "neutral",
          },
          {
            label: "历史已取消",
            value: counts?.cancelled ?? "—",
            tone: "idle",
          },
        ]}
      >
        <p className="text-xs text-muted-foreground">
          {counts
            ? `统计更新于 ${taskStamp(counts.checkedAt)}；统计独立于下方筛选。`
            : "尚未取得统计，不代表没有任务。"}
        </p>
        {overview.error && (
          <p role="alert">
            统计未刷新：{overview.error.message}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void overview.refetch()}
            >
              重试统计
            </Button>
          </p>
        )}
      </StatsPanel>
      <Panel
        icon={Queue}
        title="全部任务"
        note="退出应用可能中断任务；失败后可核对原因，前往来源页重新配置。取消不撤销已经发生的外部请求。"
      >
        <TaskHistory
          overview={counts}
          refreshOverview={() => void overview.refetch()}
        />
      </Panel>
      <RecentErrors />
    </PageGrid>
  );
}
