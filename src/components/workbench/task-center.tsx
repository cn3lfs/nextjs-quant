"use client";
import { useRef, useState } from "react";
import { ListChecks, Queue } from "@phosphor-icons/react/ssr";
import { TaskHistory } from "./task-history";
import {
  MethodologyPopover,
  PageGrid,
  Panel,
  StatsPanel,
} from "../panels";
import { taskStamp } from "~/lib/research/workflow/task-history";
import { useTaskOverview } from "./use-task-overview";
import { Button } from "../ui/button";
import { RecentErrors } from "./recent-errors";

const overviewMethodology = [
  {
    label: "统计口径",
    detail:
      "任务概览统计全部已记录任务，独立于下方筛选；时间均为北京时间。",
  },
  {
    label: "统计刷新",
    detail:
      "“统计更新于”为最近一次成功读取的时间；刷新只重新读取，不会重新发起任务。",
  },
] as const;

const taskListMethodology = [
  {
    label: "任务中断",
    detail:
      "退出应用可能中断任务；失败后可核对原因，前往来源页重新配置。",
  },
  {
    label: "取消限制",
    detail:
      "取消不撤销已经发生的外部请求，也不代表外部资源已全部释放。",
  },
] as const;

export function TaskCenter() {
  const overview = useTaskOverview();
  const counts = overview.data;
  // The panel keeps one query; a task id narrows it in place and `focus()`
  // runs in the click event so repeated clicks cannot be lost to a render.
  const [errorJobId, setErrorJobId] = useState<string | undefined>();
  const errorsPanel = useRef<HTMLDivElement>(null);
  const viewTaskErrors = (id: string) => {
    setErrorJobId(id);
    errorsPanel.current?.focus();
  };
  return (
    <PageGrid>
      <StatsPanel
        icon={ListChecks}
        title="任务概览"
        meta={
          counts
            ? `统计更新于 ${taskStamp(counts.checkedAt)}`
            : "尚未取得统计，不代表没有任务。"
        }
        actions={
          <MethodologyPopover
            title="任务概览说明"
            items={overviewMethodology}
          />
        }
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
        actions={
          <MethodologyPopover
            title="任务列表说明"
            items={taskListMethodology}
          />
        }
      >
        <TaskHistory
          overview={counts}
          refreshOverview={() => void overview.refetch()}
          onViewErrors={viewTaskErrors}
        />
      </Panel>
      <RecentErrors
        jobId={errorJobId}
        onClear={() => setErrorJobId(undefined)}
        focusRef={errorsPanel}
      />
    </PageGrid>
  );
}
