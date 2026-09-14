"use client";

import type {
  cashReconciliationPage,
  CashReconciliationDay,
  CashReconciliationStatus,
} from "~/lib/cash-reconciliation";
import {
  DataTable,
  type DataTableColumn,
  type DataTableProps,
} from "./ui/data-table";

export const cashReconciliationLabels: Record<
  CashReconciliationStatus,
  string
> = {
  matched: "日末现金相等",
  difference: "存在差异",
  unavailable: "待核对",
  conflict: "来源冲突",
};
const money = (value: number | null) =>
  value === null
    ? "—"
    : value.toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const orderLabels = {
  "single-row": "单行余额",
  "balance-chain": "余额链",
  "timestamp-chain": "时间与余额链",
};
const columns: DataTableColumn<CashReconciliationDay>[] = [
  { accessorKey: "date", header: "日期", enableSorting: false },
  {
    accessorKey: "status",
    header: "核对状态",
    enableSorting: false,
    cell: ({ row }) => cashReconciliationLabels[row.original.status],
  },
  ...(
    [
      ["statementCash", "柜台日末现金（元）"],
      ["projectedCash", "独立推算现金（元）"],
      ["difference", "差额（柜台 − 推算）"],
    ] as const
  ).map(([key, header]) => ({
    accessorKey: key,
    header,
    enableSorting: false,
    cell: ({ row }: { row: { original: CashReconciliationDay } }) =>
      money(row.original[key]),
  })),
  {
    accessorKey: "reason",
    header: "说明",
    enableSorting: false,
    cell: ({ row }) => row.original.reason ?? "已比较至分精度",
  },
  {
    id: "evidence",
    header: "核对证据",
    enableSorting: false,
    cell: ({ row }) => (
      <details>
        <summary className="cursor-pointer">
          查看 {row.original.evidence.length} 个来源
        </summary>
        {!row.original.evidence.length && <p>该日无已导入柜台余额证据。</p>}
        <ul className="space-y-3 text-sm">
          {row.original.evidence.map((source) => (
            <li key={source.batchId} className="space-y-1">
              <p>
                批次 {source.batchId}；原始行号 {source.rowIndexes.join("、")}
              </p>
              <p className="break-all">文件摘要 {source.fileHash}</p>
              <p>
                核实方式：{source.order ? orderLabels[source.order] : "未确认"}
                ；期初 {money(source.openingCash)}；日末{" "}
                {money(source.statementCash)}
              </p>
              {source.reason && <p>{source.reason}</p>}
              <details>
                <summary className="cursor-pointer">查看结构化余额证据</summary>
                <ul>
                  {source.rows.map((item) => (
                    <li key={item.rowIndex}>
                      行 {item.rowIndex}；时间 {item.time ?? "未知"}；发生额{" "}
                      {money(item.netAmount)}；余额 {money(item.balanceCash)}
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      </details>
    ),
  },
];
type Page = ReturnType<typeof cashReconciliationPage>;
type TableState = Pick<
  DataTableProps<CashReconciliationDay>,
  "pagination" | "onPaginationChange" | "loading"
>;
export function CashReconciliationResults({
  data,
  table,
}: {
  data: Page;
  table: TableState;
}) {
  const summary = data.summary;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{data.basis}</p>
      <p className="text-sm">
        全账户汇总：{summary.days} 天；可比较 {summary.comparableDays}{" "}
        天；现金相等 {summary.matchedDays} 天；存在差异 {summary.differenceDays}{" "}
        天；待核对 {summary.unavailableDays} 天；来源冲突 {summary.conflictDays}{" "}
        天。筛选只改变下表。
      </p>
      <p className="text-sm">
        证据覆盖 {summary.evidenceStart ?? "未知"} 至{" "}
        {summary.evidenceEnd ?? "未知"}；首次差异{" "}
        {summary.firstDifferenceDate ?? "无已确认差异"}；最大绝对差额{" "}
        {money(summary.maximumAbsoluteDifference)} 元。
      </p>
      <p className="text-sm text-muted-foreground">
        日末现金相等仅说明已覆盖日期金额相等，不代表流水完整、盘中余额正确或账户收益可信。
      </p>
      <details>
        <summary className="cursor-pointer">
          期初现金证据（推算起点 {data.opening.date ?? "未知"}，
          {money(data.opening.cash)} 元）
        </summary>
        {!data.opening.evidence.length ? (
          <p>未保留可用的批次期初余额证据。</p>
        ) : (
          <ul>
            {data.opening.evidence.map((source) => (
              <li key={source.batchId} className="break-all">
                批次 {source.batchId}；日期 {source.date ?? "未知"}；期初{" "}
                {money(source.value)}；与推算起点差额 {money(source.difference)}
                ；{source.reason ?? "同日起点比较"}；文件摘要 {source.fileHash}
              </li>
            ))}
          </ul>
        )}
      </details>
      {!!data.diagnostics.length && (
        <details>
          <summary className="cursor-pointer">
            导入证据待核对 {data.diagnostics.length} 项
          </summary>
          <ul>
            {data.diagnostics.map((item, index) => (
              <li key={index}>
                批次 {item.batchId}；行号 {item.rowIndex ?? "未知"}；
                {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <DataTable
        columns={columns}
        data={data.rows}
        rowCount={data.total}
        {...table}
        sorting={[]}
        onSortingChange={() => {}}
        getRowId={(row) => row.date}
        label="逐日现金核对"
        emptyMessage="当前筛选下没有现金核对记录。"
      />
    </div>
  );
}
