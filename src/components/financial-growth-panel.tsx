"use client";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
const percent = (value: number | null) =>
  value === null
    ? "缺失"
    : `${(value * 100).toLocaleString("zh-CN", { maximumFractionDigits: 3 })}%`;
const condition = (value: boolean | null) =>
  value === null ? "缺少证据" : value ? "满足" : "未满足";
export function FinancialGrowthPanel({ archiveId }: { archiveId: string }) {
  const report = api.financialGrowthReport.useQuery(archiveId),
    data = report.data;
  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section aria-label="年度增长指标">
      <h3>年度增长指标</h3>
      {report.isFetching && <p>读取后端增长计算…</p>}
      {report.error && <p role="alert">{report.error.message}</p>}
      {report.isSuccess && !data && <p>未找到来源财务档案。</p>}
      {data && (
        <>
          <p>
            基于所选财务档案计算 · {data.version}。不额外查询数据或调用模型。
          </p>
          <div style={{ overflowX: "auto" }}>
            <table aria-label="年度同比增长">
              <thead>
                <tr>
                  <th>年度</th>
                  <th>营业收入同比</th>
                  <th>合并净利润同比</th>
                </tr>
              </thead>
              <tbody>
                {data.annual.map((row) => (
                  <tr key={row.period}>
                    <td>{row.period.slice(0, 4)}</td>
                    <td title={row.revenueYoy.missing.join("；")}>
                      {percent(row.revenueYoy.value)}
                    </td>
                    <td title={row.profitYoy.missing.join("；")}>
                      {percent(row.profitYoy.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            三年区间：{data.threeYear.startPeriod?.slice(0, 4) ?? "缺失"}—
            {data.threeYear.endPeriod?.slice(0, 4) ?? "缺失"}（四个年末）。收入
            CAGR：{percent(data.threeYear.revenueCagr.value)}；合并净利润 CAGR：
            {percent(data.threeYear.profitCagr.value)}。
          </p>
          <ul>
            <li>
              连续三个年度收入正增长：
              {condition(data.revenuePositiveThreeYears.value)}
            </li>
            <li>
              连续三个年度利润正增长：
              {condition(data.profitPositiveThreeYears.value)}
            </li>
            <li>
              最近年度利润增速高于收入增速：
              {condition(data.profitGrowthAboveRevenue)}
            </li>
            <li>
              最近年度增收但利润未增长：{condition(data.revenueUpProfitNotUp)}
            </li>
          </ul>
          <Button variant="outline" onClick={download}>
            下载增长计算明细
          </Button>
          <details>
            <summary>增长公式、缺项与原始证据引用</summary>
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {JSON.stringify(data, null, 2)}
            </pre>
          </details>
          <ul>
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
