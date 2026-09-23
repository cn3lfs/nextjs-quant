"use client";
import { DataTable } from "~/components/ui/data-table";
import type { aggregateLedger } from "~/lib/strategy-facts/signal-ledger";
const name = (s: string) => (s === "czsc" ? "缠论" : "双突破");
const percent = (v: number | null) => (v === null ? "—" : `${v.toFixed(2)}%`);
// Aggregation remains in the server view; this component receives display rows only.
export function SignalLedgerSummaryTable({
  groups,
}: {
  groups: ReturnType<typeof aggregateLedger>;
}) {
  return (
    <DataTable
      label="聚合统计"
      data={groups}
      columns={[
        {
          id: "column-0",
          header: "策略",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{name(g.strategy)}</>;
          },
        },
        {
          id: "column-1",
          header: "信号质量",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{g.quality}</>;
          },
        },
        {
          id: "column-2",
          header: "期限",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>T+{g.horizon}</>;
          },
        },
        {
          id: "column-3",
          header: "样本数",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{g.samples}</>;
          },
        },
        {
          id: "column-4",
          header: "有效数",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{g.valid}</>;
          },
        },
        {
          id: "column-5",
          header: "中位收益",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{percent(g.median)}</>;
          },
        },
        {
          id: "column-6",
          header: "胜率",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{percent(g.winRate)}</>;
          },
        },
        {
          id: "column-7",
          header: "盈亏比",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{g.payoff?.toFixed(2) ?? "—"}</>;
          },
        },
        {
          id: "column-8",
          header: "留空计数",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return <>{g.blanks}</>;
          },
        },
        {
          id: "column-9",
          header: "留空原因",
          enableSorting: false,
          cell: ({ row }) => {
            const g = row.original;
            return (
              <>
                {Object.entries(g.reasons)
                  .map(([r, n]) => `${r}：${n}`)
                  .join("；") || "—"}
              </>
            );
          },
        },
      ]}
      getRowId={(g) => String(`${g.strategy}:${g.quality}:${g.horizon}`)}
      rowCount={groups.length}
      pagination={{ pageIndex: 0, pageSize: Math.max(1, groups.length) }}
      sorting={[]}
      onPaginationChange={() => {}}
      onSortingChange={() => {}}
      showPagination={false}
      emptyMessage={null}
    />
  );
}
