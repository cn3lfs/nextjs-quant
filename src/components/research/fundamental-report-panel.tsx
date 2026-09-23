"use client";
import { useEffect, useState } from "react";
import type { Snapshot } from "~/lib/domain";
import { fundamentalStageLabels } from "~/lib/research/factors/fundamental-research";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { RevenueReconciliationPanel } from "./revenue-reconciliation-panel";
import { securityDisplayName } from "~/lib/market/security-display";
type Mode = keyof typeof fundamentalStageLabels;
const modeNames = {
  fundamental: "基本面五阶段",
  guo: "郭永清七步骤",
  value: "价值投资八步骤",
};
export function FundamentalReportPanel({
  financeId,
  snapshot,
  symbol,
}: {
  financeId?: string;
  snapshot?: Snapshot;
  symbol: string;
}) {
  const utils = api.useUtils();
  const directory = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  const names = directory.data ?? {};
  const [mode, setMode] = useState<Mode>("fundamental"),
    [question, setQuestion] = useState(
      "复核财务质量、反向证据与估值假设，列明未完成的关键步骤。",
    ),
    [scenarioId, setScenarioId] = useState(""),
    [jobId, setJobId] = useState(""),
    [reportId, setReportId] = useState("");
  const scenarios = api.valuationHistory.useQuery(),
    history = api.fundamentalHistory.useQuery();
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: !!jobId,
      refetchInterval: (query) =>
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 1000
          : false,
    },
  );
  const create = api.fundamentalAnalyze.useMutation({
    onSuccess: (value) => {
      utils.job.setData({ id: value.id }, value);
      setJobId(value.id);
      setReportId("");
    },
  });
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const report = api.fundamentalReport.useQuery(
    reportId || `fundamental-report-${"0".repeat(64)}`,
    { enabled: !!reportId },
  );
  useEffect(() => {
    if (job.data?.status !== "completed") return;
    const result = job.data.result as { reportId?: string };
    if (result?.reportId) setReportId(result.reportId);
    void utils.fundamentalHistory.invalidate();
  }, [job.data?.id, job.data?.status, utils]);
  const busy =
      create.isPending ||
      ["queued", "running"].includes(job.data?.status ?? ""),
    data = report.data;
  const ready =
    financeId &&
    snapshot?.symbol === symbol &&
    snapshot.period === "day" &&
    !snapshot.historicalAsOf;
  function download() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${data.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel">
      <h2>基本面与价值资料复核</h2>
      <p className="muted">
        引用所选财务质量档案和已加载日线，按设置中的模型执行独立方法。当前为证据复核，不生成完整估值评级或交易信号。
      </p>
      {!ready && (
        <p>请先在行情页加载同一证券的当前日线，并在上方选择财务质量档案。</p>
      )}
      <fieldset disabled={busy}>
        <label className="field">
          复核方法
          <select
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as Mode);
              setScenarioId("");
            }}
          >
            {Object.entries(modeNames).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          附加人工估值场景
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
          >
            <option value="">不附场景；缺少参数不自动估值</option>
            {scenarios.data
              ?.filter(
                (row) =>
                  row.symbol === symbol &&
                  (mode === "value" ||
                    row.method ===
                      (mode === "guo" ? "guo-operating-equity" : "fcff-wacc")),
              )
              .map((row) => (
                <option key={row.id} value={row.id}>
                  {row.title} ·{" "}
                  {new Date(row.createdAt).toLocaleString("zh-CN")}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          基本面复核问题
          <textarea
            maxLength={2000}
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </label>
        <Button
          disabled={!ready || !question.trim()}
          onClick={() => {
            if (financeId && snapshot)
              create.mutate({
                financeId,
                snapshotId: snapshot.id,
                scenarioId: scenarioId || undefined,
                mode,
                question,
              });
          }}
        >
          生成资料复核报告
        </Button>
      </fieldset>
      {busy && jobId && (
        <Button
          variant="outline"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          取消资料复核
        </Button>
      )}
      {job.data && (
        <p role="status">
          {job.data.phase} · {job.data.progress}%
          {job.data.error ? ` · ${job.data.error}` : ""}
        </p>
      )}
      {(create.error || cancel.error || job.error || scenarios.error) && (
        <p role="alert">
          {create.error?.message ||
            cancel.error?.message ||
            job.error?.message ||
            scenarios.error?.message}
        </p>
      )}
      <label className="field">
        基本面复核历史
        <select
          value={reportId}
          disabled={busy}
          onChange={(event) => setReportId(event.target.value)}
        >
          <option value="">选择资料复核报告</option>
          {history.data?.map((row) => (
            <option key={row.id} value={row.id}>
              {securityDisplayName(row.symbol, names)} · {row.symbol} ·{" "}
              {row.title} · {new Date(row.createdAt).toLocaleString("zh-CN")}
            </option>
          ))}
        </select>
      </label>
      {history.error && <p role="alert">{history.error.message}</p>}
      {report.error && <p role="alert">{report.error.message}</p>}
      {report.isFetching && reportId && <p>读取基本面复核报告…</p>}
      {reportId && report.isSuccess && !data && <p>未找到该资料复核报告。</p>}
      {data && (
        <article>
          <h3>{data.result.title}</h3>
          <p>
            {modeNames[data.dossier.mode]} ·{" "}
            {securityDisplayName(data.dossier.symbol, names)} ·{" "}
            {data.dossier.symbol} · {data.model} · 记录用量 {data.tokens}
          </p>
          <p>{data.result.summary}</p>
          <Button variant="outline" onClick={download}>
            下载完整基本面复核报告
          </Button>
          <RevenueReconciliationPanel
            data={data.dossier.revenueReconciliation}
          />
          {data.result.stages.map((stage) => (
            <details key={stage.id}>
              <summary>
                {
                  (
                    fundamentalStageLabels[data.dossier.mode] as Record<
                      string,
                      string
                    >
                  )[stage.id]
                }{" "}
                · {stage.status === "missing" ? "资料不足" : "待核验分析"}
              </summary>
              <p>{stage.summary}</p>
              {[
                ["支持", stage.supporting],
                ["反方与限制", stage.opposing],
                ["缺失", stage.missing],
                ["下一步核验", stage.nextChecks],
              ].map(([label, items]) => (
                <div key={label as string}>
                  <strong>{label as string}</strong>
                  <ul>
                    {(items as string[]).map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
              <p style={{ overflowWrap: "anywhere" }}>
                证据：{stage.citations.join("；")}
              </p>
              <p style={{ overflowWrap: "anywhere" }}>
                方法：{stage.methodCitations.join("；")}
              </p>
            </details>
          ))}
          <h3>风险与后续</h3>
          <ul>
            {data.result.risks.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <ul>
            {data.result.nextSteps.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
          <details>
            <summary>原始资料、方法版本与独立估值假设</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(
                { method: data.method, dossier: data.dossier },
                null,
                2,
              )}
            </pre>
          </details>
        </article>
      )}
    </section>
  );
}
