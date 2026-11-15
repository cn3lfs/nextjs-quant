"use client";
import { usePanelVisible } from "../workbench/keep-alive";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import {
  displayAnnualFinancialRatio,
  displayFinancialRatio,
} from "~/lib/financial/financial-display";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { downloadFinancialJson } from "./financial-download";
export function FinancialArchivePanel({
  symbol,
  reportDate,
}: {
  symbol: string;
  reportDate?: string;
}) {
  const visible = usePanelVisible();
  const [jobId, setJobId] = useState(""),
    [archiveId, setArchiveId] = useState("");
  const utils = api.useUtils();
  const history = api.localFinancialArchiveHistory.useQuery(undefined, {
    enabled: visible,
  });
  const create = api.localFinancialArchiveCreate.useMutation({
    onSuccess: (job) => setJobId(job.id),
  });
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: visible && !!jobId,
      refetchInterval: (query) =>
        visible &&
        ["queued", "running"].includes(query.state.data?.status ?? "")
          ? 500
          : false,
    },
  );
  useEffect(() => {
    if (job.data?.status === "completed") {
      const result = job.data.result as { reportId?: string } | undefined;
      if (result?.reportId) setArchiveId(result.reportId);
      void utils.localFinancialArchiveHistory.invalidate();
    }
  }, [job.data?.status, job.data?.result, utils]);
  const archive = api.localFinancialArchive.useQuery(
    archiveId || `local-financial-${"0".repeat(64)}`,
    { enabled: visible && !!archiveId, retry: false },
  );
  const cancel = api.cancel.useMutation();
  const remove = api.localFinancialArchiveDelete.useMutation({
    onSuccess: () => {
      setArchiveId("");
      void history.refetch();
    },
  });
  const busy =
    create.isPending || ["running", "queued"].includes(job.data?.status ?? "");
  return (
    <section aria-label="本地财务质量档案" className="space-y-3">
      <p className="text-sm">
        将最近40期可读财报、字段原值、来源版本、年度质量和成长计算冻结为独立档案。离线生成，后续下载不改变已保存结果。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy}
          onClick={() => create.mutate({ symbol, reportDate })}
        >
          生成本地财务档案
        </Button>
        {busy && jobId && (
          <Button variant="outline" onClick={() => cancel.mutate(jobId)}>
            取消任务
          </Button>
        )}
        <Select
          value={archiveId || "none"}
          onValueChange={(value) => setArchiveId(value === "none" ? "" : value)}
        >
          <SelectTrigger aria-label="本地财务历史档案" className="max-w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">选择历史档案</SelectItem>
            {history.data?.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.symbol} · {item.reportDate ?? "无报告期"} ·{" "}
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {job.data && (
        <p role="status" className="text-xs">
          {job.data.status} · {job.data.phase} · {job.data.progress}%{" "}
          {job.data.error}
        </p>
      )}
      {(create.error || archive.error || remove.error || history.error) && (
        <p role="alert">
          {create.error?.message ??
            archive.error?.message ??
            remove.error?.message ??
            history.error?.message}
        </p>
      )}
      {archive.isFetching && <p role="status">读取已冻结的财务档案…</p>}
      {archive.data && (
        <article className="space-y-3">
          <p className="break-all text-xs">
            {archive.data.symbol} · {archive.data.reports.length}期 · 哈希{" "}
            {archive.data.hash}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                downloadFinancialJson(archive.data, archive.data!.id)
              }
            >
              导出完整冻结档案
            </Button>
            <Button
              variant="outline"
              disabled={remove.isPending}
              onClick={() => {
                if (
                  window.confirm("删除这份本地财务档案？通达信源文件保持原状。")
                )
                  remove.mutate(archiveId);
              }}
            >
              删除档案
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {archive.data.warning}{" "}
            年度质量复用已有计算。F-Score缺项不补0，不产生完整评级。
          </p>
          <div className="grid gap-2 lg:grid-cols-2">
            <div>
              收入三年CAGR：
              {displayFinancialRatio(
                archive.data.growth.threeYear.revenueCagr.value,
              )}
            </div>
            <div>
              合并利润三年CAGR：
              {displayFinancialRatio(
                archive.data.growth.threeYear.profitCagr.value,
              )}
            </div>
          </div>
          {archive.data.quality.annual.map((row) => (
            <details key={row.period}>
              <summary className="cursor-pointer text-sm">
                {row.period.slice(0, 4)}年 · 年度财务质量
              </summary>
              <ul className="text-xs">
                {Object.entries(row.ratios).map(([key, metric]) => (
                  <li key={key}>
                    {metric.formula}：
                    {displayAnnualFinancialRatio(key, metric.value)}{" "}
                    {metric.missing.join("；")}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </article>
      )}
    </section>
  );
}
