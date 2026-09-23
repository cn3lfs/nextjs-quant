"use client";
import type { RouterOutputs } from "~/trpc/react";
import {
  positionRiskMetrics,
  type PositionRiskPoint,
} from "~/lib/position-risk";
import { PositionRiskChart } from "../market/chart";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "../ui/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
const columns: DataTableColumn<PositionRiskPoint>[] = [
  { accessorKey: "date", header: "交易日" },
  ...positionRiskMetrics.map(([key, header, percent]) => ({
    id: key,
    header,
    cell: (c: { row: { original: PositionRiskPoint } }) => {
      const metric = c.row.original[key];
      return metric.value === null
        ? `不可得：${metric.reason ?? "证据不足"}`
        : percent
          ? `${(metric.value * 100).toFixed(2)}%`
          : metric.value.toFixed(4);
    },
  })),
  { accessorKey: "positionCount", header: "非零持仓标的数" },
];
export function PositionRiskResults({
  data,
  table,
  children,
}: {
  children?: import("react").ReactNode;
  data: RouterOutputs["tradeReviewPositionRisk"];
  table: Pick<
    DataTableProps<PositionRiskPoint>,
    | "pagination"
    | "sorting"
    | "onPaginationChange"
    | "onSortingChange"
    | "loading"
  >;
}) {
  const summary = data.summary;
  return (
    <Card>
      <CardHeader>
        <CardTitle>持仓集中度</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p>
          等效持仓只数中位数：
          {summary.medianEffectivePositions?.toFixed(2) ?? "不可得"}
          ；最大单一权重峰值：
          {summary.maxSingleWeight === null
            ? "不可得"
            : `${(summary.maxSingleWeight * 100).toFixed(2)}%`}
          （{summary.maxSingleWeightDate ?? "无日期"}，并列取最早日）。
        </p>
        {children}
        <p className="text-sm text-muted-foreground">
          总资产口径赫芬达尔以 nav
          为分母，含现金稀释；持仓口径赫芬达尔以持仓市值合计为分母，等效持仓只数为其倒数。未到期逆回购本金只进总资产，不进方向性持仓分子。任一持仓缺行情时，当日指标全部留空；空仓集中度无定义。摘要仅统计可得日{" "}
          {summary.availableDays} / {data.rowCount}，截止最后流水日。
        </p>
        {data.rowCount > 0 && (
          <>
            <p>
              全区间曲线：上图等效持仓只数，下图最大单一权重；不随表格翻页排序改变，缺失处断线。
            </p>
            <PositionRiskChart points={data.curve} />
          </>
        )}
        <DataTable
          label="逐日持仓集中度与敞口"
          data={data.rows}
          columns={columns}
          rowCount={data.rowCount}
          getRowId={(row) => row.date}
          emptyMessage="暂无持仓风险数据。"
          {...table}
        />
      </CardContent>
    </Card>
  );
}
