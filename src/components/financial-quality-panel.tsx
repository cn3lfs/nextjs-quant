"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import type { Snapshot } from "~/lib/domain";
import { FundamentalReportPanel } from "./fundamental-report-panel";
import { FinancialGrowthPanel } from "./financial-growth-panel";
const labels: Record<string, string> = {
  "roa-positive": "ROA为正",
  "cfo-positive": "经营现金流为正",
  "roa-improved": "ROA改善",
  "accrual-quality": "现金流与利润质量",
  "leverage-decreased": "长期债务率下降",
  "liquidity-improved": "流动比率改善",
  "no-equity-offering": "未发行新股",
  "margin-improved": "毛利率改善",
  "turnover-improved": "资产周转率改善",
};
const fmt = (value: number | null, percent = false) =>
  value === null
    ? "缺失"
    : `${(value * (percent ? 100 : 1)).toLocaleString("zh-CN", { maximumFractionDigits: 3 })}${percent ? "%" : ""}`;
export function FinancialQualityPanel({
  symbol,
  snapshot,
}: {
  symbol: string;
  snapshot?: Snapshot;
}) {
  const utils = api.useUtils();
  const [jobId, setJobId] = useState("");
  const [reportId, setReportId] = useState("");
  const history = api.financialQualityHistory.useQuery();
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
  const create = api.financialQualityCreate.useMutation({
    onSuccess: (value) => {
      utils.job.setData({ id: value.id }, value);
      setJobId(value.id);
      setReportId("");
    },
  });
  const cancel = api.cancel.useMutation({
    onSuccess: () => void job.refetch(),
  });
  const report = api.financialQualityReport.useQuery(
    reportId || `financial-quality-${"0".repeat(64)}`,
    { enabled: !!reportId },
  );
  useEffect(() => {
    if (job.data?.status !== "completed") return;
    const result = job.data.result as { reportId?: string };
    if (result?.reportId) setReportId(result.reportId);
    void utils.financialQualityHistory.invalidate();
  }, [job.data?.id, job.data?.status, utils]);
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const data = report.data;
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
      <h2>年度财务质量档案</h2>
      <p className="muted">
        当前证券：{symbol}
        。查询同花顺问财最近五个已结束年度，后端计算杜邦分解与现金流比率。当前资料不能倒填历史回测；此步骤不调用大模型。
      </p>
      <div className="actions">
        <Button disabled={busy} onClick={() => create.mutate(symbol)}>
          获取财务质量档案
        </Button>
        {busy && jobId && (
          <Button
            variant="outline"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate(jobId)}
          >
            取消财务查询
          </Button>
        )}
      </div>
      {job.data && (
        <p role="status">
          {job.data.phase} · {job.data.progress}%
          {job.data.error ? ` · ${job.data.error}` : ""}
        </p>
      )}
      {(create.error || cancel.error || job.error) && (
        <p role="alert">
          {create.error?.message || cancel.error?.message || job.error?.message}
        </p>
      )}
      <label className="field">
        财务质量历史档案
        <select
          value={reportId}
          disabled={busy}
          onChange={(event) => setReportId(event.target.value)}
        >
          <option value="">选择财务质量档案</option>
          {history.data?.map((row) => (
            <option key={row.id} value={row.id}>
              {row.symbol} · {new Date(row.createdAt).toLocaleString("zh-CN")}
            </option>
          ))}
        </select>
      </label>
      {history.error && <p role="alert">{history.error.message}</p>}
      {report.error && <p role="alert">{report.error.message}</p>}
      {report.isFetching && reportId && <p>读取财务质量档案…</p>}
      {reportId && report.isSuccess && !data && <p>未找到该财务质量档案。</p>}
      {data && (
        <article>
          <h3>{data.facts.symbol} · 年度财务质量</h3>
          <p>
            采集时间：{new Date(data.createdAt).toLocaleString("zh-CN")}；
            {data.facts.annual.length} 个年度，{data.evidence.length} 组来源。
          </p>
          <p>
            下表为来源单位下的条件性比率观察值，币种、合并范围及审计意见尚未独立核验。
          </p>
          <Button variant="outline" onClick={download}>
            下载完整财务档案
          </Button>
          {!data.facts.annual.length && (
            <p>尚无可用年度字段，请查看查询失败与原始来源。</p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>年度</th>
                  <th>净利润率</th>
                  <th>资产周转率</th>
                  <th>权益乘数</th>
                  <th>杜邦ROE</th>
                  <th>毛利率</th>
                  <th>流动比率</th>
                  <th>经营现金流/合并净利润</th>
                </tr>
              </thead>
              <tbody>
                {data.facts.annual.map((row) => (
                  <tr key={row.period}>
                    <td>{row.period.slice(0, 4)}</td>
                    <td>{fmt(row.ratios.netMargin.value, true)}</td>
                    <td>{fmt(row.ratios.assetTurnover.value)}</td>
                    <td>{fmt(row.ratios.equityMultiplier.value)}</td>
                    <td>{fmt(row.ratios.roe.value, true)}</td>
                    <td>{fmt(row.ratios.grossMargin.value, true)}</td>
                    <td>{fmt(row.ratios.currentRatio.value)}</td>
                    <td>{fmt(row.ratios.cashToProfit.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FinancialGrowthPanel archiveId={data.id} />
          <h3>
            F-Score证据检查 ·{" "}
            {data.facts.fScore.period?.slice(0, 4) ?? "无年度"}
          </h3>
          <p>
            可观察 {data.facts.fScore.knownCount}/9
            项；缺少完整口径，不生成总分。未通过条件与缺少证据分别展示。
          </p>
          <ul>
            {data.facts.fScore.items.map((item) => (
              <li key={item.id}>
                {labels[item.id] ?? item.id}：
                {item.point === null
                  ? "缺少证据"
                  : item.point === 1
                    ? "满足观察条件"
                    : "未满足观察条件"}
                。{item.reason}
              </li>
            ))}
          </ul>
          <details>
            <summary>公式、年度字段与证据引用</summary>
            {data.facts.annual.map((row) => (
              <details key={row.period}>
                <summary>{row.period.slice(0, 4)} 年计算详情</summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(row, null, 2)}
                </pre>
              </details>
            ))}
          </details>
          <details>
            <summary>查询失败与原始来源</summary>
            <p>
              失败查询：
              {data.missingProfiles.join("、") ||
                "无；请求成功不代表所需字段齐全"}
            </p>
            {data.evidence.map((entry) => (
              <details key={entry.id}>
                <summary>
                  {entry.source} · {entry.asOf}
                </summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(entry, null, 2)}
                </pre>
              </details>
            ))}
          </details>
          <ul>
            {data.facts.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </article>
      )}
      <FundamentalReportPanel
        symbol={symbol}
        financeId={data?.id}
        snapshot={snapshot}
      />
    </section>
  );
}
