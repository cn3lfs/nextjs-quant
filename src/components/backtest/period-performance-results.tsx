"use client";

import type { RouterOutputs } from "~/trpc/react";
import type { DailyPerformance } from "~/lib/backtest/daily-performance";
import type { ReviewValue } from "~/lib/portfolio/trade-review";
import { periodicWindows } from "~/lib/backtest/period-performance";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "../ui/data-table";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../ui/collapsible";

export type PeriodData = RouterOutputs["tradeReviewPeriodPerformance"];
type Segment = Omit<PeriodData["periods"][number], "window"> & {
  window: keyof typeof labels;
};
type MatrixRow = PeriodData["matrix"]["rows"][number];
const labels = {
  development: "开发段",
  validation: "保留验证段",
  tracking: "系统跟踪段",
  past1w: "过去1周",
  past2w: "过去2周",
  past1m: "过去1月",
  past3m: "过去3月",
  past6m: "过去6月",
  past1y: "过去1年",
  ytd: "今年以来",
  all: "全部",
};
const naturalLabels = {
  week: "周胜率",
  month: "月胜率",
  quarter: "季胜率",
  year: "年胜率",
};
const metrics = [
  ["totalReturn", "累计收益", true],
  ["annualReturn", "年化收益", true],
  ["sharpeWbt", "夏普（wbt）", false],
  ["maxDrawdown", "最大回撤", true],
  ["calmar", "卡玛", false],
  ["dailyWinRate", "日胜率", true],
  ["dailyPayoffRatio", "日盈亏比", false],
  ["dailyEdge", "日赢面", false],
  ["annualVolatility", "年化波动率", true],
  ["downsideVolatility", "下行波动率", true],
  ["nonzeroCoverage", "非零覆盖率", true],
  ["breakEvenPoint", "盈亏平衡点", true],
  ["newHighInterval", "新高间隔", false],
  ["newHighRatio", "新高占比", true],
  ["drawdownRisk", "回撤风险", false],
  ["regressionAnnualReturn", "回归年化收益", true],
  ["lengthAdjustedAverageDrawdown", "长度调整平均回撤", false],
] as const satisfies readonly (readonly [
  keyof DailyPerformance,
  string,
  boolean,
])[];
const display = (metric: ReviewValue, percent = true) =>
  metric.value === null
    ? `不可得：${metric.reason ?? "证据不足"}`
    : percent
      ? `${(metric.value * 100).toFixed(2)}%`
      : metric.value.toFixed(4);
const fixed = {
  sorting: [],
  onSortingChange: () => {},
  onPaginationChange: () => {},
  showPagination: false,
};
const segmentColumns: DataTableColumn<Segment>[] = [
  {
    id: "window",
    header: "分段",
    cell: (c: { row: { original: Segment } }) => labels[c.row.original.window],
  },
  { accessorKey: "startDate", header: "起始交易日" },
  { accessorKey: "endDate", header: "截止交易日" },
  { accessorKey: "tradingDays", header: "实际交易日数" },
  {
    id: "coverage",
    header: "有效 / 缺失",
    cell: (c: { row: { original: Segment } }) =>
      `${c.row.original.coverage.availableDays} / ${c.row.original.coverage.nullDays}`,
  },
  {
    id: "flags",
    header: "样本说明",
    cell: (c: { row: { original: Segment } }) => (
      <>
        <span>
          {c.row.original.truncated && (
            <Badge variant="outline">truncated：窗口不足</Badge>
          )}
        </span>
        {c.row.original.insufficientSample && (
          <Badge variant="secondary">insufficientSample：不足5日</Badge>
        )}
      </>
    ),
  },
  ...metrics.map(([key, header, percent]) => ({
    id: key,
    header,
    cell: (c: { row: { original: Segment } }) =>
      display(
        c.row.original[key],
        percent &&
          !(key === "maxDrawdown" && c.row.original.basis === "simple"),
      ),
  })),
].map((column) => ({ ...column, enableSorting: false }));

export function PeriodPerformanceResults({
  data,
  table,
  open,
  onOpenChange,
}: {
  data: PeriodData;
  table: Pick<
    DataTableProps<MatrixRow>,
    | "pagination"
    | "sorting"
    | "onPaginationChange"
    | "onSortingChange"
    | "loading"
  >;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const columns: DataTableColumn<MatrixRow>[] = [
    { accessorKey: "id", header: "标的 / 策略参数任务" },
    ...periodicWindows.map((window, i) => ({
      id: String(window),
      header: `近${window}交易日`,
      cell: (c: { row: { original: MatrixRow } }) => {
        const cell = c.row.original.cells[i]!;
        return (
          <span
            className={
              cell.value === null || cell.value === 0
                ? "text-muted-foreground"
                : cell.value > 0
                  ? "text-primary"
                  : "text-destructive"
            }
            title={`${cell.startDate ?? "无"} — ${cell.endDate ?? "无"}；实际${cell.tradingDays}交易日`}
          >
            {display(cell)}
            {cell.truncated && (
              <Badge variant="outline">truncated · {cell.tradingDays}日</Badge>
            )}
            {cell.insufficientSample && (
              <Badge variant="secondary">insufficientSample</Badge>
            )}
          </span>
        );
      },
    })),
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>分段表现</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{data.note}</p>
        <p>
          口径：
          {data.periods[0]?.basis === "simple"
            ? "单利对照（回撤为绝对值）"
            : "复利"}
          ；年化因子 {data.periods[0]?.yearlyDays}；无风险年利率{" "}
          {display({
            value: data.periods[0]?.annualRiskFreeRate ?? null,
            reason: null,
          })}
          （wbt 夏普固定 rf=0）。
        </p>
        <PerformanceSegmentTable rows={data.periods} />
        <div className="flex flex-wrap gap-4">
          {data.natural.map((row) => (
            <p key={row.period}>
              {naturalLabels[row.period]}：{display(row)}（盈利 {row.profitable}{" "}
              / 可得 {row.available}；共 {row.periods} 周期）
            </p>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          自然周期按日收益和 &gt;
          0，含首尾不完整周期；含缺失收益的周期不进分母。日胜率按 U1 的 ≥
          0，两者不可混用。
        </p>
        <Collapsible open={open} onOpenChange={onOpenChange}>
          <CollapsibleTrigger asChild>
            <Button variant="outline">
              近 N 天收益矩阵 · 共 {data.matrix.rowCount} 项 ·{" "}
              {open ? "收起" : "展开"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-3 pt-3">
            <DataTable
              label="近 N 天收益矩阵"
              data={data.matrix.rows}
              columns={columns}
              rowCount={data.matrix.rowCount}
              {...table}
              getRowId={(row) => row.id}
            />
            <DataTable
              label="矩阵全体汇总"
              data={[
                {
                  id: "盈利标的数量",
                  values: data.matrix.summary.map((s) => String(s.profitable)),
                },
                {
                  id: "盈利标的比例",
                  values: data.matrix.summary.map(
                    (s) =>
                      `${display({ value: s.ratio, reason: s.reason })}（分母 ${s.available}）`,
                  ),
                },
              ]}
              columns={[
                { accessorKey: "id", header: "全体汇总", enableSorting: false },
                ...periodicWindows.map((window, i) => ({
                  id: String(window),
                  header: `近${window}交易日`,
                  enableSorting: false,
                  cell: (c: { row: { original: { values: string[] } } }) =>
                    c.row.original.values[i],
                })),
              ]}
              rowCount={2}
              pagination={{ pageIndex: 0, pageSize: 2 }}
              getRowId={(row) => row.id}
              {...fixed}
            />
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

export function PerformanceSegmentTable({ rows }: { rows: Segment[] }) {
  return (
    <DataTable
      label="分段表现"
      data={rows}
      columns={segmentColumns}
      rowCount={rows.length}
      pagination={{ pageIndex: 0, pageSize: Math.max(1, rows.length) }}
      getRowId={(row) => row.window}
      {...fixed}
    />
  );
}
