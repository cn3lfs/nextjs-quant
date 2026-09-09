"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import type { Job } from "~/lib/domain";
import { Button } from "./ui/button";
export function OnlineScreen({
  jobs,
  onImport,
  query,
  setQuery,
}: {
  query: string;
  setQuery: (value: string) => void;
  jobs: Pick<Job, "id" | "type" | "status" | "updatedAt" | "error">[];
  onImport: (symbols: string[]) => void;
}) {
  const [id, setId] = useState("");
  const utils = api.useUtils();
  const submit = api.onlineScreen.useMutation({
    onSuccess: (job) => {
      setId(job.id);
      void utils.jobs.invalidate();
    },
  });
  const job =
    jobs.find((j) => j.id === id) ??
    jobs.find((j) => j.type === "online-screen");
  const result = api.onlineScreenResult.useQuery(
    { id: job?.id ?? "", version: job?.updatedAt },
    { enabled: job?.status === "completed" },
  );
  const data = result.data,
    busy =
      submit.isPending || job?.status === "queued" || job?.status === "running";
  const symbols = [
    ...new Set(
      data?.rows.flatMap((row) => (row.symbol ? [row.symbol] : [])) ?? [],
    ),
  ];
  function exportResult() {
    if (!data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `在线选股-第${data.page}页-${data.fetchedAt}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section id="online-screener" className="panel">
      <div className="panel-title">
        <h3>在线自然语言筛选</h3>
        <span className="tag">通达信 MCP · A 股</span>
      </div>
      <p>
        财务、行业等条件可在此查询。服务的条件解释、日期和复权口径需核对；导入代码后，再用下方本地规则复核。
      </p>
      <textarea
        aria-label="在线选股条件"
        value={query}
        maxLength={2000}
        placeholder="例如：沪深A股，市值大于1000亿元，返回股票代码、简称和最新涨跌幅"
        onChange={(e) => setQuery(e.target.value)}
      />
      <Button
        disabled={busy || query.trim().length < 2}
        onClick={() => submit.mutate({ query, page: 1 })}
      >
        {busy ? "查询中…" : "在线查询"}
      </Button>
      {(submit.error || job?.error) && (
        <p role="alert">{submit.error?.message ?? job?.error}</p>
      )}
      {data && !busy && (
        <>
          <p>
            <strong>原问句：</strong>
            {data.query}
          </p>
          {data.providerQuery && data.providerQuery !== data.query && (
            <p>服务返回问句：{data.providerQuery}</p>
          )}
          <p>{data.summary}</p>
          <p>
            获取时间：{new Date(data.fetchedAt).toLocaleString("zh-CN")} ·
            源字段日期：{data.sourceDates.join("、") || "未声明"}
          </p>
          <ul>
            {data.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!symbols.length}
              onClick={() => onImport(symbols)}
            >
              本页 {symbols.length} 只填入本地池
            </Button>
            <Button variant="ghost" onClick={exportResult}>
              导出本页与来源
            </Button>
            <Button
              variant="ghost"
              disabled={data.page <= 1}
              onClick={() =>
                submit.mutate({ query: data.query, page: data.page - 1 })
              }
            >
              上一页
            </Button>
            <span>
              第 {data.page} /{" "}
              {Math.max(1, Math.ceil(data.total / data.pageSize))} 页 · 服务返回{" "}
              {data.total} 条
            </span>
            <Button
              variant="ghost"
              disabled={data.page * data.pageSize >= data.total}
              onClick={() =>
                submit.mutate({ query: data.query, page: data.page + 1 })
              }
            >
              下一页
            </Button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>证券</th>
                  <th>本地覆盖</th>
                  {data.columns.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.index}>
                    <td>
                      {row.name}
                      <small>{row.symbol ?? row.identityWarning}</small>
                    </td>
                    <td>
                      {row.symbol ? (
                        <>
                          {data.localCoverage.find(
                            (c) => c.symbol === row.symbol,
                          )?.day
                            ? "已索引日线"
                            : "未索引日线"}{" "}
                          /{" "}
                          {data.localCoverage.find(
                            (c) => c.symbol === row.symbol,
                          )?.minute
                            ? "已索引分钟线"
                            : "未索引分钟线"}
                        </>
                      ) : (
                        "不可导入"
                      )}
                    </td>
                    {data.columns.map((c) => (
                      <td key={c.key}>
                        {typeof row.values[c.key] === "object"
                          ? JSON.stringify(row.values[c.key])
                          : String(row.values[c.key] ?? "—")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>查看工具 schema 与源指纹</summary>
            <p>{data.payloadHash}</p>
            <pre>{JSON.stringify(data.schema, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
