"use client";
import { useState } from "react";
import type { Report } from "~/lib/domain";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
export function WalkForwardExplanation({ id }: { id: string }) {
  const [jobId, setJobId] = useState("");
  const create = api.explainWalkForward.useMutation({
    onSuccess: (job) => setJobId(job.id),
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (q) =>
        ["queued", "running"].includes(q.state.data?.status ?? "")
          ? 1500
          : false,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const report =
    job.data?.status === "completed" ? (job.data.result as Report) : undefined;
  return (
    <div>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => create.mutate(id)}
      >
        {busy ? "正在解读滚动结果…" : "AI 解读滚动结果"}
      </Button>
      {busy && jobId && (
        <Button
          variant="ghost"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          取消结果解读
        </Button>
      )}
      <p className="muted">
        使用当前模型设置，默认
        Codex；只解释已归档计算结果，不重新挑选参数。相同结果和模型复用已有解读。
      </p>
      {(create.error || cancel.error || job.error || job.data?.error) && (
        <p role="alert">
          {create.error?.message ??
            cancel.error?.message ??
            job.error?.message ??
            job.data?.error}
        </p>
      )}
      {job.data?.status === "cancelled" && <p>结果解读已取消。</p>}
      {report && (
        <>
          <h4>{report.title}</h4>
          <p>{report.summary}</p>
          <p className="muted">{report.model} · 完整报告已保存在研究档案。</p>
        </>
      )}
    </div>
  );
}
