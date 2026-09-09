"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { NewsThemesReport } from "~/server/news-themes";
import { Button } from "./ui/button";
import { ThemePricesPanel } from "./theme-prices-panel";
export function NewsThemesPanel({ id }: { id: string }) {
  const [jobId, setJobId] = useState("");
  const history = api.newsThemes.useQuery(id);
  const create = api.analyzeNewsThemes.useMutation({
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
  useEffect(() => {
    if (job.data?.status === "completed") void history.refetch();
  }, [job.data?.status]);
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const report =
    job.data?.status === "completed"
      ? (job.data.result as NewsThemesReport)
      : history.data;
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { format: "quant-news-themes-export-1", ...report },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${report.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel">
      <h4>当天跨行业主题</h4>
      <p className="muted">
        按已有新闻数量选取前7个行业，每类最多10条；宏观、市场情绪和国际市场单列。使用当前模型，默认
        Codex；证据不足时不生成跨行业主题。
      </p>
      <Button disabled={busy} onClick={() => create.mutate(id)}>
        {busy ? "主题研究中…" : "AI 提炼跨行业主题"}
      </Button>
      {busy && jobId && (
        <Button
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          取消主题研究
        </Button>
      )}
      {(create.error || cancel.error || job.data?.error) && (
        <p role="alert">
          {create.error?.message ?? cancel.error?.message ?? job.data?.error}
        </p>
      )}
      {job.data?.status === "cancelled" && <p>主题研究已取消。</p>}
      {report && (
        <>
          <p>
            {report.model} · 使用 {report.sources.length} 条新闻 · 冲突隔离{" "}
            {report.aggregation.conflicts.length} 条。仅代表已有分类覆盖。
          </p>
          <p>
            {report.result.summary.text}（新闻{" "}
            {report.result.summary.citations.join("、")}）
          </p>
          <p>
            重点行业：
            {report.ranked
              .map((r) => `${r.industry} ${r.count}条`)
              .join("、") || "无"}
          </p>
          {!report.result.themes.length && (
            <p>现有证据不足以支持跨行业共同主题。</p>
          )}
          {report.result.themes.map((theme, i) => (
            <div key={i}>
              <h5>
                {theme.title} · {theme.industries.join(" / ")}
              </h5>
              <p>
                {theme.logic.text}（新闻 {theme.logic.citations.join("、")}）
              </p>
              <p>证伪条件：{theme.invalidation}</p>
            </div>
          ))}
          <h5>背景</h5>
          {report.result.background.map((c, i) => (
            <p key={i}>
              {c.text}（新闻 {c.citations.join("、")}）
            </p>
          ))}
          <h5>风险与缺口</h5>
          {report.result.risks.map((c, i) => (
            <p key={i}>
              {c.text}（新闻 {c.citations.join("、")}）
            </p>
          ))}
          {report.result.missing.map((text, i) => (
            <p key={i}>{text}</p>
          ))}
          <Button variant="outline" onClick={download}>
            下载主题报告及原文证据
          </Button>
          <ThemePricesPanel key={report.id} themeId={report.id} />
        </>
      )}
    </section>
  );
}
