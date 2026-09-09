"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { ThemePrices } from "~/server/theme-prices";
import { Button } from "./ui/button";
import { ThemePriceExplanation } from "./theme-price-explanation";
const pct = (n: number | null) => (n === null ? "缺失" : `${n.toFixed(2)}%`);
export function ThemePricesPanel({ themeId }: { themeId: string }) {
  const [jobId, setJobId] = useState("");
  const history = api.themePrices.useQuery(themeId);
  const create = api.checkThemePrices.useMutation({
    onSuccess: (job) => setJobId(job.id),
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
  useEffect(() => {
    if (job.data?.status === "completed") void history.refetch();
  }, [job.data?.status]);
  const busy =
    create.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  const report =
    job.data?.status === "completed"
      ? (job.data.result as ThemePrices)
      : history.data;
  function download() {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            { format: "quant-theme-prices-export-1", ...report },
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
      <h4>重点行业价格核验</h4>
      <p className="muted">
        腾讯历史指数日线，按原主题截止时点筛选完整日线；不调用模型。相同报告60秒内复用查询结果。
      </p>
      <Button disabled={busy} onClick={() => create.mutate(themeId)}>
        {busy ? "价格查询中…" : "核验重点行业价格"}
      </Button>
      {busy && jobId && (
        <Button
          disabled={cancel.isPending}
          onClick={() => cancel.mutate(jobId)}
        >
          取消价格查询
        </Button>
      )}
      {(create.error || job.data?.error || cancel.error) && (
        <p role="alert">
          {create.error?.message ?? job.data?.error ?? cancel.error?.message}
        </p>
      )}
      {job.data?.status === "cancelled" && <p>价格查询已取消。</p>}
      {report && (
        <>
          <p>
            抓取时间：{new Date(report.data.fetchedAt).toLocaleString()} ·
            原报告截止：{new Date(report.data.cutoff).toLocaleString()}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>行业 / 指数</th>
                  <th>数据日期</th>
                  <th>5区间涨幅</th>
                  <th>30区间涨幅</th>
                  <th>相对上证5区间</th>
                  <th>5/前20均量比</th>
                  <th>距窗口收盘高点</th>
                </tr>
              </thead>
              <tbody>
                {report.data.metrics?.results.map((r) => (
                  <tr key={r.symbol}>
                    <td>
                      {
                        report.data.mappings.find((m) => m.symbol === r.symbol)
                          ?.industry
                      }{" "}
                      / {r.symbol}
                    </td>
                    <td>{r.asOf ?? "缺失"}</td>
                    <td>{pct(r.return5)}</td>
                    <td>{pct(r.return30)}</td>
                    <td>{pct(r.excess5)}</td>
                    <td>{r.volumeRatio?.toFixed(2) ?? "缺失"}</td>
                    <td>{pct(r.closeDrawdown)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.data.metrics?.results.flatMap((r) =>
            r.warnings.map((w, i) => (
              <p key={`${r.symbol}-${i}`}>
                {r.symbol}：{w}
              </p>
            )),
          )}
          {report.data.failures.map((f) => (
            <p key={f.industry}>
              {f.industry}：{f.reason}
            </p>
          ))}
          <details>
            <summary>数据来源与口径</summary>
            {report.envelope.warnings.map((w, i) => (
              <p key={i}>{w}</p>
            ))}
            <p>证据哈希：{report.envelope.payloadHash}</p>
          </details>
          <Button variant="outline" onClick={download}>
            下载价格核验及原始数据
          </Button>
          <ThemePriceExplanation key={report.id} id={report.id} />
        </>
      )}
    </section>
  );
}
