"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { Report } from "~/lib/domain";
import { Button } from "./ui/button";
export function ThemePriceExplanation({ id }: { id: string }) {
  const [jobId, setJobId] = useState("");
  const create = api.explainThemePrices.useMutation({
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
      <Button disabled={busy} onClick={() => create.mutate(id)}>
        {busy ? "对照解读中…" : "AI 对照新闻与价格"}
      </Button>
      {busy && jobId && (
        <Button
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          取消对照解读
        </Button>
      )}
      <p className="muted">
        使用当前模型，默认 Codex；只解读已归档证据，同证据同模型复用报告。
      </p>
      {(create.error || job.data?.error || cancel.error) && (
        <p role="alert">
          {create.error?.message ?? job.data?.error ?? cancel.error?.message}
        </p>
      )}
      {job.data?.status === "cancelled" && <p>对照解读已取消。</p>}
      {report && (
        <>
          <h5>{report.title}</h5>
          <p>{report.summary}</p>
          <p className="muted">
            {report.model} · 完整解读与引用已保存在研究档案。
          </p>
        </>
      )}
    </div>
  );
}
