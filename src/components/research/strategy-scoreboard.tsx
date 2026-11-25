"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import { api } from "~/trpc/react";
import { alertDisplayCopy } from "~/lib/common/ui-glossary";
import { useAccumulatedPages, useTablePage } from "../ui/use-infinite-table";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Segmented } from "../panels";
import type { CurrentScoreboardRow } from "~/server/db/validation-scoreboard";
import { benchmarkBasisLabel } from "./benchmark-basis";

const rowKey = (row: CurrentScoreboardRow) => row.id;
const pct = (value: number | null) =>
  value === null ? "—" : `${displayNumber(value * 100, 2)}%`;
const columns: DataTableColumn<CurrentScoreboardRow>[] = [
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
    id: "benchmarkBasis",
    header: "基准口径",
    enableSorting: false,
    cell: ({ row }) => benchmarkBasisLabel(row.original.benchmarkBasis),
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
          {row.original.forward?.promoted
            ? "已晋级"
            : row.original.shadow?.active
              ? "空跑验证中"
              : "研究"}{" "}
          · 闭合交易 {row.original.trades}
        </p>
        {row.original.shadow && (
          <p>
            开始{" "}
            {new Date(row.original.shadow.startedAt).toLocaleDateString(
              "zh-CN",
            )}{" "}
            · 空跑验证 {row.original.shadow.signals} 个信号 /{" "}
            {row.original.shadow.days} 日
            {row.original.shadow.paused ? " · 容量已达上限，已暂停采集" : ""}；
          </p>
        )}
        {row.original.forward && (
          <p>
            前推一致性：
            {row.original.forward.verdict === "conforming"
              ? "一致"
              : row.original.forward.verdict === "degraded"
                ? "衰减"
                : "证据不足"}
            ；{alertDisplayCopy(row.original.forward.recommendation)}
            {row.original.forward.reasons.length > 0 &&
              `；${alertDisplayCopy(row.original.forward.reasons.join("、"))}`}
          </p>
        )}
        {row.original.dsr && (
          <p>
            市场DSR {displayNumber(row.original.dsr.value, 3) ?? "—"} · 全局DSR{" "}
            {displayNumber(row.original.globalDsr?.value, 3) ?? "—"}（诊断）
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
            {displayNumber(row.original.riskAdjusted.sharpeDifference, 3) ??
              "—"}
            ； Calmar 差{" "}
            {displayNumber(row.original.riskAdjusted.calmarDifference, 3) ??
              "—"}
          </p>
        )}
        <p>{alertDisplayCopy(row.original.reasons.join("；"))}</p>
      </div>
    ),
  },
];
export function StrategyScoreboard({ enabled }: { enabled: boolean }) {
  const [market, setMarket] = useState<"cn-equity" | "crypto">("cn-equity");
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const resetKey = JSON.stringify([market, sorting]);
  const cursor = useTablePage(resetKey);
  const sort = sorting[0];
  const report = api.strategyScoreboard.useQuery(
    {
      market,
      page: cursor.pageIndex,
      sort: sort?.id === "excess" || sort?.id === "drawdown" ? sort.id : "id",
      descending: sort?.desc ?? false,
    },
    {
      enabled,
      refetchInterval: enabled && cursor.pageIndex === 0 ? 60000 : false,
    },
  );
  const result =
    report.isSuccess && !report.isPlaceholderData ? report.data : undefined;
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: cursor.pageIndex,
    items: result?.rows,
    total: result?.total,
    getKey: rowKey,
    metadata: result?.metadata,
  });
  return (
    <section className="space-y-4" aria-label="策略研究成绩单">
      <Segmented
        label="研究市场"
        value={market}
        onChange={setMarket}
        options={[
          { value: "cn-equity", label: "A 股" },
          { value: "crypto", label: "数字货币" },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        留出诊断已用于研究迭代，不能再视为新的样本外。候选登记后开始空跑验证，只记录信号，不推送或下单；信号计数不代表组合盈亏；当前建议使用同版本冻结分布的纸面前推一致性，回测门槛和前推一致性均通过才可晋级。正式提醒和订阅仍须手动开启。价格、证券池与成交证据缺口继续适用。
      </p>
      {batches.metadata && (
        <p className="break-all text-xs text-muted-foreground">
          输入摘要：{batches.metadata.inputHash} · {batches.metadata.universe} ·
          数据缺口 {batches.metadata.gaps.length} 项 · 未运行候选{" "}
          {batches.metadata.missing.length} 项
        </p>
      )}
      <DataTable
        label="研究成绩单"
        columns={columns}
        data={batches.rows}
        rowCount={batches.total}
        infiniteScroll={{
          hasMore: batches.hasMore,
          loadingMore: cursor.pageIndex > 0 && report.isFetching,
          onLoadMore: cursor.loadMore,
        }}
        sorting={sorting}
        onSortingChange={setSorting}
        getRowId={rowKey}
        loading={report.isFetching || report.isPending}
        error={report.error?.message}
        onRetry={() => {
          void report.refetch();
        }}
        emptyMessage="尚无已完成的研究成绩单。研究任务完成后在此显示。"
      />
    </section>
  );
}
