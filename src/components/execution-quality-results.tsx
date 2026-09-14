"use client";

import type { RouterOutputs } from "~/trpc/react";
import {
  executionDiagnosticCategories,
  executionDiagnosticLabels,
  type ExecutionRow,
} from "~/lib/execution-quality";
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
      ["slippageBp", "日均价不利偏差 BP"],
      ["slippageCost", "偏差金额折算"],
      ["amount", "成交额"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    cell: ({ row }: { row: { original: ExecutionRow } }) =>
      show(row.original[key]),
  })),
  {
    id: "diagnostic",
    header: "诊断",
    enableSorting: false,
    cell: ({ row }) =>
      executionDiagnosticLabels[row.original.diagnostic.category],
  },
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
  { accessorKey: "validBpCount", header: "有效偏差笔数", enableSorting: false },
  { accessorKey: "weightedCount", header: "可加权笔数", enableSorting: false },
  ...(
    [
      ["amount", "成交额"],
      ["weightedAmount", "可加权成交额"],
      ["slippageCost", "偏差金额折算"],
      ["arithmeticMeanBp", "笔数平均偏差 BP"],
      ["averageSlippageBp", "成交额加权偏差 BP"],
      ["totalCost", "费用与偏差折算合计"],
      ["costBp", "合计占成交额 BP"],
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
    ["费用与偏差折算合计", show(data.summary.totalCost)],
    ["偏差金额折算（元）", show(data.summary.slippageCost)],
    ["日均价偏差（BP，成交额加权）", show(data.summary.averageSlippageBp)],
    data.fallbackNote
      ? [
          "全账户期末总资产差（元，实际 − VWAP 反事实）",
          show(data.terminalDifference),
        ]
      : ["全账户反事实差（实际 TWR − VWAP TWR）", show(data.loss, true)],
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        基准：当日 VWAP（{data.benchmark.kind}）。日均价偏差正 = 不利（买贵了 /
        卖便宜了），负 =
        有利。全天均价包含成交之后的信息，仅作事后描述，不能证明真实执行优势。
        逆回购不参与；倍率按成交价识别，数量单位无法确认时留空。
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
          "反事实假设同样标的、同样数量按全天均价成交，不代表可实现的执行结果；负值表示实际结果较低。反事实始终使用全账户，描述性偏差、费用与分组随筛选变化。"}
      </p>
      <p className="text-sm text-muted-foreground">
        反事实收盘净值非正 {data.counterfactualNonPositiveDays ?? "—"} 天；
        最低已知收盘净值：
        {data.counterfactualWorstNav
          ? `${data.counterfactualWorstNav.value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 元（${data.counterfactualWorstNav.date}）`
          : "—"}
        。仅统计可得收盘总资产，缺失日不计入；诊断与期末差始终使用全账户。
      </p>
      <p className="text-sm text-muted-foreground">
        笔数平均偏差 {show(data.summary.arithmeticMeanBp)} BP；有效偏差{" "}
        {data.summary.validBpCount} / {data.summary.count} 笔（覆盖{" "}
        {show(data.summary.countCoverage, true)}）。 可加权{" "}
        {data.summary.weightedCount} 笔，成交额{" "}
        {show(data.summary.weightedAmount)}，金额覆盖{" "}
        {show(data.summary.amountCoverage, true)}； 排除{" "}
        {data.summary.excludedCount} 笔，成交额{" "}
        {show(data.summary.excludedAmount)}。
        任一所需金额缺失时严格加权结果仍留空，不以部分数据冒充完整汇总。
      </p>
      <p className="text-sm text-muted-foreground">
        {executionDiagnosticCategories
          .filter((category) => category !== "valid")
          .map(
            (category) =>
              `${executionDiagnosticLabels[category]} ${data.summary.diagnosticCounts[category]} 笔`,
          )
          .join("；")}
        。 超过 500 BP
        只表示排除描述性汇总，未证明单位错误，仍沿用既有全账户反事实规则。
        偏差金额折算 = BP × 成交额 / 10000，不是实际节省费用；费用独立保留。
      </p>
      <p className="text-sm">
        佣金 {show(data.summary.fees.commission)}；印花税{" "}
        {show(data.summary.fees.stampTax)}；过户费{" "}
        {show(data.summary.fees.transferFee)}；杂费{" "}
        {show(data.summary.fees.otherFee)}；总费用{" "}
        {show(data.summary.fees.total)}；费用与偏差折算合计占成交额{" "}
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
