"use client";
import { useState } from "react";
import Link from "next/link";
import { formatNumber } from "trading-strategy-core/format-number";
import { taskHistoryHref } from "~/lib/research/workflow/task-history-location";
import { api } from "~/trpc/react";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../ui/table";
import { useArchiveDownload } from "../use-archive-download";
import {
  comparisonExportDocument,
  comparisonScope,
  formatPercent,
} from "./comparison-export";
import type { HistoryQuery } from "./shared";

export function RunHistoryWorkspace({
  panelVisible,
  active,
  history,
  strategyNames,
  onMessage,
}: {
  panelVisible: boolean;
  active: boolean;
  history: HistoryQuery;
  strategyNames: ReadonlyMap<string, string>;
  onMessage: (message: string) => void;
}) {
  const [evaluationId, setEvaluationId] = useState("");
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparedIds, setComparedIds] = useState<string[]>([]);
  const comparison = api.strategyCenterCompare.useQuery(comparedIds, {
    enabled: panelVisible && active && comparedIds.length >= 2,
  });
  const report = api.strategyCenterEvaluation.useQuery(evaluationId, {
    enabled: panelVisible && active && !!evaluationId,
  });
  const utils = api.useUtils();
  const comparisonDownload = useArchiveDownload();
  const comparisonBasis = comparison.data?.[0]?.comparisonBasis;
  async function exportResult(id: string) {
    try {
      const result = await utils.strategyCenterExport.fetch(id);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${id}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "导出失败");
    }
  }
  return (
    <>
      {history.isLoading && <p role="status">正在读取运行历史…</p>}
      {history.error && (
        <p role="alert">
          历史读取失败：{history.error.message}
          <Button variant="outline" onClick={() => void history.refetch()}>
            重读历史
          </Button>
        </p>
      )}
      {history.data?.length === 0 && (
        <p>尚无运行记录。在策略目录核对输入后创建实验。</p>
      )}
      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">运行历史</h2>
          <Button
            disabled={compareIds.length < 2 || comparison.isFetching}
            onClick={() => {
              if (JSON.stringify(comparedIds) === JSON.stringify(compareIds))
                void comparison.refetch();
              else setComparedIds([...compareIds]);
            }}
          >
            比较所选（{compareIds.length}/12）
          </Button>
        </div>
        <p className="text-sm text-nc-text-3">
          选择2至12个已完成实验后比较；当前选择不会改写已经展示的比较结果。
        </p>
        {history.data?.map((job) => (
          <div
            key={job.id}
            className="flex flex-wrap items-center gap-3 rounded border p-3 text-sm"
          >
            <span>
              {job.symbol} · {job.strategyId} · {job.status}
            </span>
            {job.status === "completed" && (
              <>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={compareIds.includes(job.id)}
                    disabled={
                      !compareIds.includes(job.id) && compareIds.length >= 12
                    }
                    onCheckedChange={(checked) =>
                      setCompareIds((current) =>
                        checked
                          ? [...current, job.id].slice(-12)
                          : current.filter((id) => id !== job.id),
                      )
                    }
                  />
                  加入比较
                </label>
                <Button
                  variant="outline"
                  onClick={() => setEvaluationId(job.id)}
                >
                  查看绩效
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void exportResult(job.id)}
                >
                  导出冻结输入与完整结果
                </Button>
              </>
            )}
            <a
              href={taskHistoryHref({ id: job.id })}
              className="text-primary underline"
            >
              任务详情
            </a>
          </div>
        ))}
      </section>
      {report.error && <p role="alert">{report.error.message}</p>}
      {comparison.error && <p role="alert">{comparison.error.message}</p>}
      {comparison.data && (
        <section className="rounded border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-medium">同口径比较</h2>
            {comparison.data.length > 0 && (
              <Button
                variant="outline"
                disabled={comparison.isFetching || !!comparison.error}
                onClick={() =>
                  comparisonDownload.save(
                    () =>
                      JSON.stringify(
                        comparisonExportDocument(comparison.data!),
                        null,
                        2,
                      ),
                    "策略中心-同口径比较.json",
                    "application/json",
                    "比较摘要导出未成功，请重试；已显示的冻结结果未被修改。",
                  )
                }
              >
                导出比较摘要
              </Button>
            )}
          </div>
          {comparisonDownload.error && (
            <p role="alert">{comparisonDownload.error}</p>
          )}
          <p className="text-sm text-nc-text-3">
            已提交比较 {comparedIds.length} 项
            {JSON.stringify(comparedIds) !== JSON.stringify(compareIds)
              ? "；选择已修改，请重新比较。"
              : ""}
          </p>
          {comparisonBasis && (
            <div className="mt-2 space-y-1 text-sm">
              <p>
                共同冻结输入区间：{comparisonBasis.start} 至{" "}
                {comparisonBasis.end}
              </p>
              <p>
                独立本金 {comparisonBasis.initial} ·{" "}
                {comparisonScope(comparisonBasis)}
              </p>
            </div>
          )}
          <Table className="mt-2 w-full text-sm">
            <TableHeader>
              <TableRow>
                <TableHead>策略 / 任务</TableHead>
                <TableHead>累计收益</TableHead>
                <TableHead>年化收益</TableHead>
                <TableHead>最大回撤</TableHead>
                <TableHead>夏普</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {comparison.data.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="align-top whitespace-normal">
                    <span className="block max-w-[10rem] truncate">
                      {strategyNames.get(item.strategyId) ?? item.strategyId}
                    </span>
                    <Link
                      href={taskHistoryHref({ id: item.id })}
                      className="block break-all text-xs text-primary underline"
                    >
                      任务 {item.id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {formatPercent(item.overview.totalReturn.value)}
                  </TableCell>
                  <TableCell>
                    {formatPercent(item.overview.annualReturn.value)}
                  </TableCell>
                  <TableCell>
                    {formatPercent(item.overview.maxDrawdown.value)}
                  </TableCell>
                  <TableCell>
                    {formatNumber(item.overview.sharpe.value, 2) ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      {report.data && (
        <section className="space-y-3 rounded border p-4">
          <h2 className="font-medium">绩效评价 · {evaluationId}</h2>
          <p className="text-sm">
            累计收益 {formatPercent(report.data.overview.totalReturn.value)} ·
            年化收益 {formatPercent(report.data.overview.annualReturn.value)} ·
            最大回撤 {formatPercent(report.data.overview.maxDrawdown.value)} ·
            夏普 {formatNumber(report.data.overview.sharpe.value, 2) ?? "—"}
          </p>
          <p className="text-xs text-muted-foreground">
            252日年化、2%无风险假设；评价只读派生，不改变冻结回放。未提供基准时不计算超额收益。
          </p>
          {(["year", "quarter", "month"] as const).map((frequency) => (
            <details key={frequency}>
              <summary>
                {{ year: "年度", quarter: "季度", month: "月度" }[frequency]}
              </summary>
              <Table className="w-full text-sm">
                <TableHeader>
                  <TableRow>
                    <TableHead>期间</TableHead>
                    <TableHead>收益</TableHead>
                    <TableHead>最大回撤</TableHead>
                    <TableHead>夏普</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.data[frequency].map((period) => (
                    <TableRow key={period.key}>
                      <TableCell>
                        {period.key}
                        {period.boundary ? "（部分周期）" : ""}
                      </TableCell>
                      <TableCell>
                        {formatPercent(period.evaluation.totalReturn.value)}
                      </TableCell>
                      <TableCell>
                        {formatPercent(period.evaluation.maxDrawdown.value)}
                      </TableCell>
                      <TableCell>
                        {formatNumber(period.evaluation.sharpe.value, 2) ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </details>
          ))}
        </section>
      )}
    </>
  );
}
