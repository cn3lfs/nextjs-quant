"use client";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "~/components/ui/select";
import { DataTable } from "~/components/ui/data-table";
import { useState } from "react";
import { api } from "~/trpc/react";
import { taskStatusLabels, taskTypeLabels } from "~/lib/task-history";
import type { Job } from "~/lib/domain";
import { Button } from "./ui/button";
import { WorkProgressView } from "./screen-task-progress";
type Cursor = { createdAt: number; id: string };
export function TaskHistory() {
  const [open, setOpen] = useState(false),
    [status, setStatus] = useState<Job["status"] | "">("");
  const [cursors, setCursors] = useState<(Cursor | undefined)[]>([undefined]);
  const [selected, setSelected] = useState("");
  const utils = api.useUtils();
  const history = api.taskHistory.useQuery(
    { status: status || undefined, cursor: cursors.at(-1) },
    { enabled: open, refetchOnWindowFocus: false, staleTime: Infinity },
  );
  const detail = api.taskState.useQuery(
    { id: selected },
    {
      enabled: open && !!selected,
      refetchInterval: (q) =>
        ["running", "queued"].includes(q.state.data?.status ?? "")
          ? 2000
          : false,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => {
      void detail.refetch();
      void history.refetch();
      void utils.jobs.invalidate();
    },
  });
  function reset() {
    setCursors([undefined]);
    setSelected("");
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>全部任务与失败详情</summary>
      <p>
        每页 20 条，按创建时间倒序。历史列表按需加载；运行中的状态详情自动更新。
      </p>
      <label>
        任务状态{" "}
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value as Job["status"] | "");
            reset();
          }}
        >
          <SelectTrigger aria-label="历史任务状态">
            <SelectValue placeholder="全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部</SelectItem>
            {Object.entries(taskStatusLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>{" "}
      <Button
        variant="outline"
        disabled={history.isFetching}
        onClick={() => {
          reset();
          void utils.taskHistory.invalidate();
        }}
      >
        刷新任务历史
      </Button>
      {history.error && <p role="alert">{history.error.message}</p>}
      {history.isFetching && <p role="status">正在读取任务历史…</p>}
      {history.data && (
        <>
          <p>
            共 {history.data.total} 条 · 第 {cursors.length} 页
          </p>
          <DataTable
            label="任务历史"
            data={history.data.items}
            rowCount={history.data.total}
            pagination={{ pageIndex: cursors.length - 1, pageSize: 20 }}
            sorting={[]}
            onPaginationChange={() => {}}
            onSortingChange={() => {}}
            showPagination={false}
            emptyMessage={null}
            getRowId={(job) => job.id}
            columns={[
              {
                id: "type",
                header: "任务",
                enableSorting: false,
                cell: ({ row }) =>
                  taskTypeLabels[row.original.type] ?? row.original.type,
              },
              {
                id: "status",
                header: "状态",
                enableSorting: false,
                cell: ({ row }) =>
                  taskStatusLabels[row.original.status] ?? row.original.status,
              },
              {
                id: "progress",
                header: "进度 / 阶段",
                enableSorting: false,
                cell: ({ row: { original: job } }) => (
                  <>
                    {job.progress}% · {job.error || job.phase || "—"}
                    {(job.phaseTruncated || job.errorTruncated) &&
                      "（摘要，详情可查看全文）"}
                  </>
                ),
              },
              {
                id: "createdAt",
                header: "创建时间",
                enableSorting: false,
                cell: ({ row }) =>
                  new Date(row.original.createdAt).toLocaleString("zh-CN"),
              },
              {
                id: "detail",
                header: "详情",
                enableSorting: false,
                cell: ({ row: { original: job } }) => (
                  <Button variant="ghost" onClick={() => setSelected(job.id)}>
                    查看任务 {job.id.slice(-8)}
                  </Button>
                ),
              },
            ]}
          />
          {history.data.items.length === 0 && <p>没有符合条件的任务</p>}
          <Button
            variant="outline"
            disabled={cursors.length === 1 || history.isFetching}
            onClick={() => {
              setCursors((p) => p.slice(0, -1));
              setSelected("");
            }}
          >
            上一页任务
          </Button>{" "}
          <Button
            variant="outline"
            disabled={!history.data.nextCursor || history.isFetching}
            onClick={() => {
              setCursors((p) => [...p, history.data!.nextCursor!]);
              setSelected("");
            }}
          >
            下一页任务
          </Button>
        </>
      )}
      {selected && (
        <section aria-label="任务状态详情">
          <h4>任务状态详情</h4>
          <p>{selected}</p>
          {detail.error && <p role="alert">{detail.error.message}</p>}
          {detail.isPending && <p>正在读取详情…</p>}
          {detail.data === null && <p>任务不存在</p>}
          {detail.data && (
            <>
              <p>
                {taskTypeLabels[detail.data.type]} ·{" "}
                {taskStatusLabels[detail.data.status]} · {detail.data.progress}%
              </p>
              <p>阶段：{detail.data.phase || "未记录"}</p>
              <WorkProgressView counts={detail.data.workProgress} />
              <p>
                创建于 {new Date(detail.data.createdAt).toLocaleString("zh-CN")}{" "}
                · 最后更新{" "}
                {new Date(detail.data.updatedAt).toLocaleString("zh-CN")}
              </p>
              <p>
                {["queued", "running"].includes(detail.data.status)
                  ? "已等待 / 运行"
                  : "总历时"}{" "}
                {Math.max(
                  0,
                  ((["queued", "running"].includes(detail.data.status)
                    ? Date.now()
                    : detail.data.updatedAt) -
                    detail.data.createdAt) /
                    1000,
                ).toFixed(2)}{" "}
                秒
              </p>
              {detail.data.error && (
                <p
                  role="alert"
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {detail.data.error}
                </p>
              )}
              {["queued", "running"].includes(detail.data.status) && (
                <Button
                  variant="outline"
                  disabled={cancel.isPending}
                  onClick={() => cancel.mutate(selected)}
                >
                  取消所选任务
                </Button>
              )}
            </>
          )}
          {cancel.error && <p role="alert">{cancel.error.message}</p>}
        </section>
      )}
    </details>
  );
}
