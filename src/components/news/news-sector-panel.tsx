"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { NewsAnalysis } from "~/server/news/news-analysis";
import type { NewsSectorReport } from "~/server/news/news-sector";
import { Button } from "../ui/button";

export function NewsSectorPanel({ analysis }: { analysis: NewsAnalysis }) {
  const industries = [...new Set(analysis.items.map((i) => i.industry))];
  const [industry, setIndustry] = useState(industries[0] ?? ""),
    [jobId, setJobId] = useState("");
  const history = api.newsSectorReports.useQuery(analysis.id);
  const create = api.analyzeNewsSector.useMutation({
    onSuccess: (job) => setJobId(job.id),
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (q) =>
        ["queued", "running"].includes(q.state.data?.status ?? "")
          ? 2000
          : false,
    },
  );
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  useEffect(() => {
    if (job.data?.status === "completed") void history.refetch();
  }, [job.data?.status]);
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const report =
    job.data?.status === "completed" &&
    (job.data.result as NewsSectorReport).input.industry === industry
      ? (job.data.result as NewsSectorReport)
      : history.data?.find((r) => r.input.industry === industry);
  return (
    <section className="panel">
      <h4>行业新闻研究</h4>
      <p className="muted">
        使用本次分类档案中所选行业最新50条已分类新闻。仅解释新闻，价格、估值和关联个股尚待核验。
      </p>
      <select
        aria-label="新闻研究行业"
        value={industry}
        disabled={busy}
        onChange={(e) => setIndustry(e.target.value)}
      >
        {industries.map((name) => (
          <option key={name} value={name}>
            {name}（{analysis.items.filter((i) => i.industry === name).length}
            条）
          </option>
        ))}
      </select>
      <Button
        disabled={busy || !industry}
        onClick={() => create.mutate({ analysisId: analysis.id, industry })}
      >
        {busy ? "行业研究中…" : "分析行业机会与风险"}
      </Button>
      {busy && jobId && (
        <Button
          variant="outline"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          取消行业研究
        </Button>
      )}
      {(create.error || cancel.error || job.error || history.error) && (
        <p role="alert">
          {
            (create.error ?? cancel.error ?? job.error ?? history.error)
              ?.message
          }
        </p>
      )}
      {job.data?.status === "failed" && <p role="alert">{job.data.error}</p>}
      {job.data?.status === "cancelled" && <p>行业研究已取消。</p>}
      {report && (
        <>
          <p>
            {report.model} · 已用 {report.coverage.selected}/
            {report.coverage.available} 条行业新闻 · 分类完成{" "}
            {report.coverage.classified}/{report.coverage.original}
          </p>
          {report.classificationAggregation && (
            <p className="muted">
              当天已有分类汇总，共{" "}
              {report.classificationAggregation.archiveIds.length}{" "}
              份来源档案，隔离{" "}
              {report.classificationAggregation.conflicts.length}{" "}
              条冲突新闻；不代表当天全部新闻覆盖。
            </p>
          )}
          <p>
            {report.result.summary.text}（新闻{" "}
            {report.result.summary.citations.join("、")}）
          </p>
          {(
            [
              ["facts", "新闻事实"],
              ["opportunities", "可能机会"],
              ["risks", "风险"],
              ["observations", "验证与证伪条件"],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <h5>{label}</h5>
              <ul>
                {report.result[key].map((item, i) => (
                  <li key={i}>
                    {item.text}（新闻 {item.citations.join("、")}）
                    {"invalidation" in item && <p>证伪：{item.invalidation}</p>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <h5>缺失数据</h5>
          <ul>
            {report.result.missing.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
          <details>
            <summary>行业研究原文与方法</summary>
            {report.sources.map((s) => (
              <details key={s.news.id}>
                <summary>
                  {s.news.id} · {s.news.title}
                </summary>
                <p className="whitespace-pre-wrap">{s.news.content}</p>
              </details>
            ))}
            <pre>{JSON.stringify(report.method, null, 2)}</pre>
          </details>
          <Button
            variant="outline"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob(
                  [
                    JSON.stringify(
                      { format: "quant-news-sector-export-1", ...report },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json;charset=utf-8" },
                ),
              );
              const a = document.createElement("a");
              a.href = url;
              a.download = `行业研究-${report.id.slice(-16)}.json`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            下载行业研究与原文
          </Button>
        </>
      )}
    </section>
  );
}
