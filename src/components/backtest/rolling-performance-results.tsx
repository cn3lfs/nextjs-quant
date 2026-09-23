"use client";

import type { RouterOutputs } from "~/trpc/react";
import {
  rollingMetrics,
  rollingPerformanceDefaults,
  type RollingPoint,
} from "~/lib/backtest/rolling-performance";
import { RollingPerformanceChart } from "../market/chart";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "../ui/data-table";
import { Badge } from "../ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";

const columns: DataTableColumn<RollingPoint>[] = [
  { accessorKey: "endDate", header: "截止交易日" },
  { accessorKey: "startDate", header: "起始交易日" },
  { accessorKey: "tradingDays", header: "实际交易日数" },
  {
    id: "coverage",
    header: "观察 / 可得 / 缺失 / 零收益日",
    enableSorting: false,
    cell: (c: { row: { original: RollingPoint } }) => {
      const coverage = c.row.original.coverage;
      return `${coverage.observedDays} / ${coverage.availableDays} / ${coverage.nullDays} / ${coverage.zeroReturnDays}`;
    },
  },
  {
    id: "insufficientCoverage",
    header: "覆盖说明",
    enableSorting: false,
    cell: (c: { row: { original: RollingPoint } }) =>
      c.row.original.insufficientCoverage ? (
        <Badge variant="secondary">insufficientCoverage：覆盖不足</Badge>
      ) : (
        "覆盖达标"
      ),
  },
  ...rollingMetrics.map(([key, header, percent]) => ({
    id: key,
    header,
    cell: (c: { row: { original: RollingPoint } }) => {
      const metric = c.row.original[key];
      return metric.value === null
        ? `不可得：${metric.reason ?? "证据不足"}`
        : percent &&
            !(key === "maxDrawdown" && c.row.original.basis === "simple")
          ? `${(metric.value * 100).toFixed(2)}%`
          : metric.value.toFixed(4);
    },
  })),
];

export function RollingPerformanceResults({
  data,
  table,
}: {
  data: RouterOutputs["tradeReviewRollingPerformance"];
  table: Pick<
    DataTableProps<RollingPoint>,
    | "pagination"
    | "sorting"
    | "onPaginationChange"
    | "onSortingChange"
    | "loading"
  >;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>滚动绩效</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{data.note}</p>
        <p>
          窗口 {data.window} 交易日；第 {data.minPeriods} 个交易日起算；
          {data.basis === "simple" ? "单利对照，回撤为绝对值" : "复利"}
          ；年化因子 {data.yearlyDays ?? "暂无点"}。
        </p>
        <p>
          可得日占比低于 {rollingPerformanceDefaults.minimumCoverage * 100}%
          标记 insufficientCoverage，指标仍展示。共 {data.rowCount}{" "}
          点，其中覆盖不足 {data.insufficientCount} 点；null
          不补零，不满窗不补齐。
        </p>
        {data.rowCount > 0 && (
          <>
            <p>
              全区间曲线（不随表格排序翻页改变）：上图夏普 / 中图最大回撤 /
              下图年化收益；含覆盖不足窗口，请结合表格核对。
            </p>
            <RollingPerformanceChart
              points={data.curve}
              simple={data.basis === "simple"}
            />
          </>
        )}
        <DataTable
          label="滚动绩效完整指标"
          data={data.rows}
          columns={columns}
          rowCount={data.rowCount}
          getRowId={(row) => row.endDate}
          emptyMessage="尚未达到最少交易日数，暂无滚动点。"
          {...table}
        />
      </CardContent>
    </Card>
  );
}
