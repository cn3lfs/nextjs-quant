"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { Snapshot } from "~/lib/domain";
import { Button } from "./ui/button";
import { securityDisplayName } from "~/lib/security-display";

const labels = {
  morphology: "形态与包含关系",
  center: "中枢与走势级别",
  dynamics: "背驰与动力",
  points: "买卖点前提",
  conclusion: "核验结论",
};
export function ChanPanel({
  snapshot,
  archive = false,
  initialReportId = "",
}: {
  snapshot?: Snapshot;
  archive?: boolean;
  initialReportId?: string;
}) {
  const utils = api.useUtils();
  const [question, setQuestion] = useState(
    "核对当前窗口的结构假设、级别前提和反证条件。",
  );
  const [jobId, setJobId] = useState("");
  const [reportId, setReportId] = useState(initialReportId);
  const history = api.chanHistory.useQuery(undefined, {
    enabled: archive && !initialReportId,
  });
  const directory = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  const names = directory.data ?? {};
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (q) =>
        ["queued", "running"].includes(q.state.data?.status ?? "")
          ? 1000
          : false,
    },
  );
  const create = api.chanAnalyze.useMutation({
    onSuccess: (value) => {
      utils.job.setData({ id: value.id }, value);
      setJobId(value.id);
      setReportId("");
    },
  });
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const report = api.chanReport.useQuery(
    reportId || `chan-report-${"0".repeat(64)}`,
    { enabled: !!reportId },
  );
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  useEffect(() => {
    if (job.data?.status !== "completed") return;
    const value = job.data.result as { reportId?: string };
    if (value?.reportId) setReportId(value.reportId);
    void utils.chanHistory.invalidate();
  }, [job.data?.id, job.data?.status, utils]);
  const data = report.data;
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `缠论标注-${data.evidence.symbol}-${data.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel">
      <h3>缠论标注研究</h3>
      <p className="muted">
        用于人工核验结构与课文定义。图周期不等于走势级别，笔、线段和中枢算法尚未验收，不生成自动信号。
      </p>
      {!archive && (
        <>
          <label className="field">
            <span>缠论研究问题</span>
            <textarea
              value={question}
              maxLength={2000}
              rows={3}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </label>
          <Button
            disabled={!snapshot || busy || !question.trim()}
            onClick={() =>
              snapshot && create.mutate({ snapshotId: snapshot.id, question })
            }
          >
            生成缠论标注
          </Button>
        </>
      )}
      {busy && (
        <p role="status">
          {job.data?.phase ?? "提交任务"} · {job.data?.progress ?? 0}%{" "}
          <Button
            disabled={!jobId || cancel.isPending}
            onClick={() => cancel.mutate(jobId)}
          >
            取消缠论任务
          </Button>
        </p>
      )}
      {job.data?.status === "cancelled" && <p>缠论任务已取消</p>}
      {(create.error || job.data?.error || cancel.error) && (
        <p role="alert">
          {create.error?.message ?? job.data?.error ?? cancel.error?.message}
        </p>
      )}
      {job.error && (
        <p role="alert">
          状态读取失败，后台可能仍在运行。
          <Button onClick={() => void job.refetch()}>重试缠论状态</Button>
        </p>
      )}
      {archive && !initialReportId && (
        <label className="field">
          <span>缠论研究档案</span>
          <select
            value={reportId}
            disabled={busy}
            onChange={(e) => setReportId(e.target.value)}
          >
            <option value="">选择缠论报告</option>
            {history.data?.map((item) => (
              <option key={item.id} value={item.id}>
                {securityDisplayName(item.symbol, names)} · {item.symbol} ·{" "}
                {item.title} ·{" "}
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
        </label>
      )}
      {archive && !initialReportId && history.isLoading && (
        <p role="status">正在读取缠论档案…</p>
      )}
      {archive && !initialReportId && history.error && (
        <p role="alert">
          档案读取失败。
          <Button onClick={() => void history.refetch()}>重试缠论档案</Button>
        </p>
      )}
      {archive &&
        !initialReportId &&
        history.isSuccess &&
        !history.data.length && <p>暂无缠论标注报告。</p>}
      {reportId && report.isLoading && <p role="status">正在读取缠论报告…</p>}
      {reportId && report.error && (
        <p role="alert">
          报告读取失败。
          <Button onClick={() => void report.refetch()}>重试缠论报告</Button>
        </p>
      )}
      {reportId && report.isSuccess && !data && (
        <p role="alert">缠论报告不存在。</p>
      )}
      {data && (
        <>
          <h4>{data.result.title}</h4>
          <p>{data.result.summary}</p>
          <p className="muted">
            {securityDisplayName(data.evidence.symbol, names)} ·{" "}
            {data.evidence.symbol} ·{" "}
            {data.evidence.period === "day" ? "日线图" : "五分钟图"} · 不复权 ·
            截至 {data.evidence.asOf} · {data.model}
          </p>
          <p>{data.method.source}</p>
          <Button onClick={download}>下载缠论证据档案</Button>
          {data.result.stages.map((stage) => (
            <details key={stage.id} open>
              <summary>
                {labels[stage.id]} ·{" "}
                {stage.status === "hypothesis" ? "待核验假设" : "证据不足"}
              </summary>
              <p>{stage.summary}</p>
              {stage.annotations.map((annotation, i) => (
                <div key={i}>
                  <strong>{annotation.label}</strong>
                  <p>
                    窗口索引 {annotation.startIndex}–{annotation.endIndex} ·{" "}
                    {data.evidence.bars[annotation.startIndex]?.date} 至{" "}
                    {data.evidence.bars[annotation.endIndex]?.date}
                  </p>
                  <p>核验条件：{annotation.verification}</p>
                </div>
              ))}
              <p>缺口：{stage.missing.join("；")}</p>
              {stage.passageIds.map((id) => {
                const passage = data.method.passages.find((p) => p.id === id);
                return passage ? (
                  <blockquote key={id}>
                    <p style={{ whiteSpace: "pre-wrap" }}>{passage.quote}</p>
                    <footer>
                      第 {passage.lessons.join("、")} 课 · {passage.file}:
                      {passage.line}
                      <br />
                      {passage.heading}
                    </footer>
                  </blockquote>
                ) : (
                  <p key={id} role="alert">
                    引用条目缺失：{id}
                  </p>
                );
              })}
            </details>
          ))}
          <h4>风险</h4>
          <ul>
            {data.result.risks.map((risk, i) => (
              <li key={i}>{risk}</li>
            ))}
          </ul>
          <h4>下一步核验</h4>
          <ul>
            {data.result.nextSteps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ul>
          <details>
            <summary>方法版本与完整证据</summary>
            <pre>
              {JSON.stringify(
                {
                  version: data.method.version,
                  files: data.method.files,
                  evidence: data.evidence,
                  automaticSignals: data.automaticSignals,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
