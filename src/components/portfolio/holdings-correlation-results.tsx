"use client";
import type { RouterOutputs } from "~/trpc/react";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "../ui/data-table";
type Data = RouterOutputs["tradeReviewHoldingsCorrelation"];
type Row = Data["rows"][number];
export function HoldingsCorrelationResults({
  data,
  table,
}: {
  data: Data;
  table: Pick<
    DataTableProps<Row>,
    | "pagination"
    | "sorting"
    | "onPaginationChange"
    | "onSortingChange"
    | "loading"
  >;
}) {
  const columns: DataTableColumn<Row>[] = [
    { accessorKey: "symbol", header: "证券" },
    ...data.symbols.map((symbol, index) => ({
      id: symbol,
      header: symbol,
      enableSorting: false,
      cell: (c: { row: { original: Row } }) => {
        const metric = c.row.original.cells[index]!;
        return (
          <span title={metric.reason ?? undefined}>
            {metric.value === null
              ? `不可得：${metric.reason}`
              : metric.value.toFixed(4)}
            （{metric.overlapDays} 日）
          </span>
        );
      },
    })),
  ];
  return (
    <section aria-label="持仓相关性" className="space-y-3">
      <p>
        平均相关性：
        {data.averagePairwise.value?.toFixed(4) ??
          `不可得：${data.averagePairwise.reason}`}
        ；可得证券对 {data.pairCount.available}，不可得{" "}
        {data.pairCount.insufficient}（不含对角线）。
      </p>
      <p className="text-sm text-muted-foreground">
        等效持仓只数衡量权重是否分散，平均相关性衡量它们是否同向运动；两者都低才是真分散。
      </p>
      <p className="text-sm text-muted-foreground">
        说明：等效持仓只数越大表示权重越分散；上句“两者都低”中的权重指标应理解为集中度。相关性使用复盘专用未复权收盘价日收益，除权可能影响结果；成对完整且至少
        20
        日，零方差留空。行按证券服务端分页，仅展示当前页证券对全部证券的相关性，摘要统计全区间。
      </p>
      <DataTable
        label="持仓价格收益相关性矩阵"
        columns={columns}
        data={data.rows}
        rowCount={data.rowCount}
        getRowId={(r) => r.symbol}
        emptyMessage="复盘区间内无非逆回购持仓。"
        {...table}
      />
    </section>
  );
}
