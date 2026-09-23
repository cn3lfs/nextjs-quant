"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { Snapshot } from "~/lib/domain";
import { Button } from "../ui/button";
import { canslimSourceLabel } from "~/lib/canslim-source-label";
import { securityDisplayName } from "~/lib/security-display";
const labels = {
  market: "市场环境",
  "data-coverage": "资料覆盖",
  scoring: "分项评分",
  patterns: "技术形态",
  "entry-risk": "入场与风险",
  conclusion: "研究结论",
};
export function CanslimPanel({
  snapshot,
  archive = false,
  initialReportId = "",
}: {
  snapshot?: Snapshot;
  archive?: boolean;
  initialReportId?: string;
}) {
  const [jobId, setJob] = useState("");
  const [reportId, setReport] = useState(initialReportId);
  const history = api.canslimHistory.useQuery(undefined, {
    enabled: archive && !initialReportId,
  });
  const directory = api.securityNames.useQuery(undefined, { staleTime: 60000 });
  const names = directory.data ?? {};
  const create = api.canslimAnalyze.useMutation({
    onSuccess: (job) => {
      setJob(job.id);
      setReport("");
    },
  });
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
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const report = api.canslimReport.useQuery(
    reportId || `canslim-report-${"0".repeat(64)}`,
    { enabled: !!reportId },
  );
  useEffect(() => {
    if (job.data?.status === "completed") {
      const result = job.data.result as { reportId?: string };
      if (result?.reportId) setReport(result.reportId);
      if (archive) void history.refetch();
    }
  }, [job.data?.status, job.data?.id]);
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const data = report.data;
  return (
    <section className="panel">
      <h3>CANSLIM 六阶段研究</h3>
      <p className="muted">
        展示17项计算与证据缺口。尚未完成全部因子和交易风险核验，不构成完整评级。
      </p>
      {!archive && (
        <Button
          disabled={
            !snapshot ||
            snapshot.period !== "day" ||
            !!snapshot.historicalAsOf ||
            busy
          }
          onClick={() => snapshot && create.mutate({ snapshotId: snapshot.id })}
        >
          生成 CANSLIM 报告
        </Button>
      )}
      {busy && (
        <p role="status">
          {job.data?.phase ?? "提交任务"} · {job.data?.progress ?? 0}%{" "}
          <Button
            onClick={() => cancel.mutate(jobId)}
            disabled={!jobId || cancel.isPending}
          >
            取消
          </Button>
        </p>
      )}
      {job.data?.status === "cancelled" && <p>任务已取消</p>}
      {job.error && (
        <p role="alert">
          任务状态读取失败：{job.error.message}。后台任务可能仍在运行。
          <Button onClick={() => void job.refetch()} disabled={job.isFetching}>
            重试读取状态
          </Button>
        </p>
      )}
      {cancel.error && (
        <p role="alert">
          取消请求失败：{cancel.error.message}。请确认任务状态后重试。
        </p>
      )}
      {(create.error || job.data?.error || report.error) && (
        <p role="alert">
          {create.error?.message ?? job.data?.error ?? report.error?.message}
        </p>
      )}
      {archive && !initialReportId && (
        <label className="field">
          <span>CANSLIM 研究档案</span>
          <select value={reportId} onChange={(e) => setReport(e.target.value)}>
            <option value="">选择报告</option>
            {history.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {securityDisplayName(r.symbol, names)} · {r.symbol} · {r.title}{" "}
                · {new Date(r.createdAt).toLocaleString("zh-CN")}
              </option>
            ))}
          </select>
        </label>
      )}
      {archive && !initialReportId && history.isLoading && (
        <p role="status">正在读取研究档案…</p>
      )}
      {archive && !initialReportId && history.error && (
        <p role="alert">
          研究档案读取失败：{history.error.message}
          <Button
            onClick={() => void history.refetch()}
            disabled={history.isFetching}
          >
            重试读取档案
          </Button>
        </p>
      )}
      {archive &&
        !initialReportId &&
        history.isSuccess &&
        !history.data.length && (
          <p>暂无 CANSLIM 报告，请在日线行情页面生成研究报告。</p>
        )}
      {!!reportId && report.isLoading && <p role="status">正在读取报告…</p>}
      {!!reportId && report.isSuccess && !data && (
        <p role="alert">CANSLIM 报告不存在。</p>
      )}
      {!!reportId && report.error && (
        <Button
          onClick={() => void report.refetch()}
          disabled={report.isFetching}
        >
          重试读取报告
        </Button>
      )}
      {data && (
        <>
          <h4>{data.result.title}</h4>
          <p className="muted">
            关联证券：{securityDisplayName(data.dossier.symbol, names)} ·{" "}
            {data.dossier.symbol}
          </p>
          <p>{data.result.summary}</p>
          {!!data.dossier.sourceFailures?.length && (
            <p role="alert">
              本次未成功取得：
              {[...new Set(data.dossier.sourceFailures)]
                .map(canslimSourceLabel)
                .join("、")}
              。 已取得的资料仍可查看，失败不表示该项条件不成立。
            </p>
          )}
          <p className="muted">
            {data.model} · 计算得分 {data.dossier.scorecard.computedPoints}/
            {data.dossier.scorecard.maxPoints} · 可计算覆盖{" "}
            {data.dossier.scorecard.computedCapacity}/
            {data.dossier.scorecard.maxPoints}
          </p>
          <p>
            原方法标称116分，分项实际合计114分；这里采用分项之和，不对缺失项重新折算。
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>分项</th>
                  <th>分值</th>
                  <th>状态</th>
                  <th>依据与缺口</th>
                </tr>
              </thead>
              <tbody>
                {data.dossier.scorecard.checks.map((c) => (
                  <tr key={c.id}>
                    <td>{c.id}</td>
                    <td>
                      {c.points}/{c.maxPoints}
                    </td>
                    <td>
                      {c.status === "computed"
                        ? "可计算"
                        : c.status === "conflict"
                          ? "冲突"
                          : "缺失"}
                    </td>
                    <td>{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.result.stages.map((s) => (
            <section key={s.id}>
              <h4>
                {labels[s.id]} ·{" "}
                {s.status === "missing"
                  ? "前提未齐"
                  : s.status === "supported"
                    ? "支持"
                    : "反证"}
              </h4>
              <p>{s.summary}</p>
              <ul>
                {s.missing.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
              <details>
                <summary>阶段引用</summary>
                {s.citations.map((id) => (
                  <p key={id}>
                    {data.dossier.evidence.find((e) => e.id === id)?.source} ·{" "}
                    {id}
                  </p>
                ))}
              </details>
            </section>
          ))}
          <h4>风险与下一步</h4>
          <ul>
            {[...data.result.risks, ...data.result.nextSteps].map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
          <details>
            <summary>证据与方法版本</summary>
            {data.dossier.evidence.map((e) => (
              <details key={e.id}>
                <summary>
                  {e.source} · {e.asOf}
                </summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(e, null, 2)}
                </pre>
              </details>
            ))}
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(data.method, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
