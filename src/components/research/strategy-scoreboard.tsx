"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Segmented } from "../panels";
import type { ScoreboardRow } from "~/server/research/validation-model";

const pct = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const columns: DataTableColumn<ScoreboardRow>[] = [
  {
    id: "id",
    header: "策略 / 分仓 / 组合",
    accessorKey: "id",
    enableSorting: true,
    cell: ({ row }) => (
      <div>
        <p>{row.original.rule}</p>
        <p className="text-xs text-muted-foreground">{row.original.id}</p>
      </div>
    ),
  },
  { id: "sleeve", header: "分仓", accessorKey: "sleeve", enableSorting: false },
  {
    id: "return",
    header: "留出收益",
    enableSorting: false,
    cell: ({ row }) => pct(row.original.return),
  },
  {
    id: "excess",
    header: "超额",
    enableSorting: true,
    cell: ({ row }) => pct(row.original.excess),
  },
  {
    id: "drawdown",
    header: "最大回撤",
    enableSorting: true,
    cell: ({ row }) => pct(row.original.drawdown),
  },
  {
    id: "windows",
    header: "样本外达标 / 窗口",
    enableSorting: false,
    cell: ({ row }) =>
      `${row.original.positiveWindows} / ${row.original.oosWindows}`,
  },
  {
    id: "status",
    header: "结论与偏差",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="max-w-96 text-xs">
        <p>
          {row.original.status === "live-candidate"
            ? "可监视候选"
            : row.original.status === "shadow-candidate"
              ? row.original.shadow?.active === false
                ? "影子观察已结束"
                : "影子前推中"
              : "研究"}{" "}
          · 闭合交易 {row.original.trades}
        </p>
        {row.original.shadow && (
          <p>
            开始{" "}
            {new Date(row.original.shadow.startedAt).toLocaleDateString(
              "zh-CN",
            )}{" "}
            · 前推 {row.original.shadow.signals} 个信号 /{" "}
            {row.original.shadow.days} 日
            {row.original.shadow.paused ? " · 容量已达上限，已暂停采集" : ""}；
            {row.original.shadow.assessment?.recommendation ??
              "达到30个信号或60日后评估"}
          </p>
        )}
        {row.original.dsr && (
          <p>
            市场DSR {row.original.dsr.value?.toFixed(3) ?? "—"} · 全局DSR{" "}
            {row.original.globalDsr?.value?.toFixed(3) ?? "—"}（诊断）
          </p>
        )}
        <p>
          {row.original.bias.universe}；{row.original.bias.adjustment}；
          {row.original.bias.financial}；{row.original.bias.execution}
        </p>
        {row.original.biasTags?.map((tag) => (
          <p key={tag.code}>
            偏差（{tag.severity === "high" ? "高" : "中"}）：{tag.detail}
          </p>
        ))}
        {row.original.riskAdjusted && (
          <p title={row.original.riskAdjusted.basis}>
            夏普差{" "}
            {row.original.riskAdjusted.sharpeDifference?.toFixed(3) ?? "—"}；
            Calmar 差{" "}
            {row.original.riskAdjusted.calmarDifference?.toFixed(3) ?? "—"}
          </p>
        )}
        <p>{row.original.reasons.join("；")}</p>
      </div>
    ),
  },
];
export function StrategyScoreboard({ enabled }: { enabled: boolean }) {
  const [market, setMarket] = useState<"cn-equity" | "crypto">("cn-equity");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const sort = sorting[0];
  const report = api.strategyScoreboard.useQuery(
    {
      market,
      page: pagination.pageIndex,
      sort: sort?.id === "excess" || sort?.id === "drawdown" ? sort.id : "id",
      descending: sort?.desc ?? false,
    },
    { enabled, refetchInterval: enabled ? 60000 : false },
  );
  return (
    <section className="space-y-4" aria-label="策略研究成绩单">
      <Segmented
        label="研究市场"
        value={market}
        onChange={(value) => {
          setMarket(value);
          setPagination({ pageIndex: 0, pageSize: 20 });
        }}
        options={[
          { value: "cn-equity", label: "A 股" },
          { value: "crypto", label: "数字货币" },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        留出诊断已用于研究迭代，不能再视为新的样本外。影子候选从登记后积累前推观察，保持零投递；达到30个信号或60个实际观察市场日后按同一门槛给建议。开启live和订阅仍须手动设置。价格、证券池与成交证据缺口继续适用。
      </p>
      {report.data?.metadata && (
        <p className="break-all text-xs text-muted-foreground">
          输入摘要：{report.data.metadata.inputHash} ·{" "}
          {report.data.metadata.universe} · 数据缺口{" "}
          {report.data.metadata.gaps.length} 项 · 未运行候选{" "}
          {report.data.metadata.missing.length} 项
        </p>
      )}
      <DataTable
        label="研究成绩单"
        columns={columns}
        data={report.data?.rows ?? []}
        rowCount={report.data?.total ?? 0}
        pagination={pagination}
        sorting={sorting}
        onPaginationChange={setPagination}
        onSortingChange={(next) => {
          setSorting(next);
          setPagination({ pageIndex: 0, pageSize: 20 });
        }}
        getRowId={(r) => r.id}
        loading={report.isLoading}
        error={report.error?.message}
        onRetry={() => {
          void report.refetch();
        }}
        emptyMessage="尚无已完成的研究成绩单。研究任务完成后在此显示。"
      />
    </section>
  );
}
