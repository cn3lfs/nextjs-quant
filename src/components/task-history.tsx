"use client";
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
        <select
          aria-label="历史任务状态"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as Job["status"] | "");
            reset();
          }}
        >
          <option value="">全部</option>
          {Object.entries(taskStatusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
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
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>任务</th>
                  <th>状态</th>
                  <th>进度 / 阶段</th>
                  <th>创建时间</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((job) => (
                  <tr key={job.id}>
                    <td>{taskTypeLabels[job.type] ?? job.type}</td>
                    <td>{taskStatusLabels[job.status] ?? job.status}</td>
                    <td>
                      {job.progress}% · {job.error || job.phase || "—"}
                      {(job.phaseTruncated || job.errorTruncated) &&
                        "（摘要，详情可查看全文）"}
                    </td>
                    <td>{new Date(job.createdAt).toLocaleString("zh-CN")}</td>
                    <td>
                      <Button
                        variant="ghost"
                        onClick={() => setSelected(job.id)}
                      >
                        查看任务 {job.id.slice(-8)}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
