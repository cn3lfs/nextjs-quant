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
    header: "样本外正超额 / 窗口",
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
          {row.original.status === "live-candidate" ? "可监视候选" : "研究"} ·
          闭合交易 {row.original.trades}
        </p>
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
    { enabled },
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
        候选显示末段留出诊断（与滚动样本外重叠），分仓与组合显示全期描述回放。通过门槛才标记可监视候选；成绩单不会开启实时提醒。价格、证券池与成交证据缺口仍适用，规则自检不等于可信业绩。
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
