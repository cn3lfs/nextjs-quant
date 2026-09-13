"use client";

import type { RouterOutputs } from "~/trpc/react";
import type { ExecutionRow } from "~/lib/execution-quality";
import type { ReviewValue } from "~/lib/trade-review";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "./ui/data-table";

type Result = RouterOutputs["tradeReviewExecution"];
type TableState<T extends object> = Pick<
  DataTableProps<T>,
  | "pagination"
  | "sorting"
  | "onPaginationChange"
  | "onSortingChange"
  | "loading"
>;
const show = (v: ReviewValue, percent = false) =>
  v.value === null
    ? `—（${v.reason}）`
    : `${(v.value * (percent ? 100 : 1)).toLocaleString("zh-CN", { maximumFractionDigits: 4 })}${percent ? "%" : ""}`;
const columns: DataTableColumn<ExecutionRow>[] = [
  { accessorKey: "tradeDate", header: "日期" },
  { accessorKey: "code", header: "代码" },
  { accessorKey: "name", header: "名称", enableSorting: false },
  {
    accessorKey: "kind",
    header: "方向",
    cell: ({ row }) => (row.original.kind === "buy" ? "买入" : "卖出"),
  },
  ...(
    [
      ["price", "成交价"],
      ["vwap", "当日 VWAP"],
      ["slippageBp", "不利滑点 BP"],
      ["slippageCost", "滑点成本"],
      ["amount", "成交额"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    cell: ({ row }: { row: { original: ExecutionRow } }) =>
      show(row.original[key]),
  })),
  {
    id: "fees",
    header: "总费用",
    enableSorting: false,
    cell: ({ row }) => show(row.original.fees.total),
  },
];
type Group = Result["groups"][number];
const groupColumns: DataTableColumn<Group>[] = [
  {
    accessorKey: "id",
    header: "分组",
    enableSorting: false,
    cell: ({ row }) =>
      ({ buy: "买入", sell: "卖出" })[row.original.id] ?? row.original.id,
  },
  { accessorKey: "count", header: "笔数", enableSorting: false },
  ...(
    [
      ["amount", "成交额"],
      ["slippageCost", "滑点成本"],
      ["averageSlippageBp", "成交额加权不利滑点 BP"],
      ["totalCost", "总执行成本"],
      ["costBp", "成本占成交额 BP"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    enableSorting: false,
    cell: ({ row }: { row: { original: Group } }) => show(row.original[key]),
  })),
  ...(
    [
      ["commission", "佣金"],
      ["stampTax", "印花税"],
      ["transferFee", "过户费"],
      ["otherFee", "杂费"],
      ["total", "总费用"],
    ] as const
  ).map(([key, header]) => ({
    id: key,
    header,
    enableSorting: false,
    cell: ({ row }: { row: { original: Group } }) =>
      show(row.original.fees[key]),
  })),
];
export function ExecutionQualityResults({
  data,
  table,
  groupTable,
}: {
  data: Result;
  table: TableState<ExecutionRow>;
  groupTable: TableState<Group>;
}) {
  const cards = [
    ["总执行成本", show(data.summary.totalCost)],
    ["总滑点成本", show(data.summary.slippageCost)],
    ["平均不利滑点（BP，成交额加权）", show(data.summary.averageSlippageBp)],
    data.fallbackNote
      ? [
          "期末总资产差（元，实际 − VWAP 反事实）",
          show(data.terminalDifference),
        ]
      : ["执行损耗（实际 TWR − VWAP TWR）", show(data.loss, true)],
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        基准：当日 VWAP（{data.benchmark.kind}）。不利滑点正 = 不利（买贵了 /
        卖便宜了），负 =
        有利。逆回购不参与执行质量统计；可转债均价已对齐交割单价格单位。
      </p>
      <div className="grid gap-3 md:grid-cols-4">
        {cards.map(([label, value]) => (
          <div
            key={label}
            className="rounded-lg border border-border bg-card p-4"
          >
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="break-words font-medium">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        {data.fallbackNote ??
          "实际净值与『同样标的同样数量按当日均价成交』的净值之差，只反映成交价格好坏，不含选股优劣。损耗负值表示实际表现较差；执行损耗始终使用全账户，其他成本与分组随筛选变化。"}
      </p>
      <p className="text-sm text-muted-foreground">
        反事实收盘净值非正 {data.counterfactualNonPositiveDays ?? "—"} 天；
        最低已知收盘净值：
        {data.counterfactualWorstNav
          ? `${data.counterfactualWorstNav.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元（${data.counterfactualWorstNav.date}）`
          : "—"}
        。仅统计可得收盘总资产，缺失日不计入；诊断与期末差始终使用全账户。
      </p>
      <p className="text-sm">
        佣金 {show(data.summary.fees.commission)}；印花税{" "}
        {show(data.summary.fees.stampTax)}；过户费{" "}
        {show(data.summary.fees.transferFee)}；杂费{" "}
        {show(data.summary.fees.otherFee)}；总费用{" "}
        {show(data.summary.fees.total)}；成本占成交额{" "}
        {show(data.summary.costBp)} BP。
      </p>
      {data.loss.value === null && data.segments.length > 0 && (
        <details>
          <summary>查看同边界分段执行损耗</summary>
          <ul>
            {data.segments.map((s, i) => (
              <li key={i}>
                {s.start} 至 {s.end}：{show(s.loss, true)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <DataTable
        columns={columns}
        data={data.rows}
        rowCount={data.rowCount}
        {...table}
        getRowId={(r) => r.id}
        label="逐笔执行质量"
      />
      <DataTable
        columns={groupColumns}
        data={data.groups}
        rowCount={data.groupCount}
        {...groupTable}
        getRowId={(r) => r.id}
        label="执行质量分组汇总"
      />
    </div>
  );
}
