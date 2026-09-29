"use client";
import { DataTable } from "../ui/data-table";
import type { RouterOutputs } from "~/trpc/react";
import { TradeError, tradeNumber } from "./trade-workspace-fields";
export function TradeComparison({
  data,
  fetching,
  error,
  onRetry,
}: {
  data?: RouterOutputs["tradeWorkspaceComparison"];
  fetching: boolean;
  error?: string;
  onRetry: () => void;
}) {
  return (
    <section aria-label="信号比较" className="space-y-3">
      <p className="text-sm text-nc-text-3">
        按是否关联任一交易分组，比较完整账本对应的同口径 N1
        向前收益。非实际交易盈亏、非策略业绩，不代表跟随信号的因果效果；不受交易列表筛选影响。
      </p>
      <TradeError error={error} onRetry={onRetry} />
      {fetching && <p role="status">正在读取完整样本比较…</p>}
      {!fetching && !error && data?.length === 0 && <p>暂无可比较台账信号。</p>}
      <div className="overflow-x-auto">
        <DataTable
          label="做过与没做的信号"
          data={data ?? []}
          columns={[
            {
              id: "group",
              header: "分组",
              enableSorting: false,
              cell: ({ row }) => row.original.group,
            },
            {
              id: "strategy",
              header: "策略/质量",
              enableSorting: false,
              cell: ({ row }) =>
                `${row.original.strategy}/${row.original.quality}`,
            },
            {
              id: "horizon",
              header: "期限",
              enableSorting: false,
              cell: ({ row }) => `T+${row.original.horizon}`,
            },
            {
              id: "samples",
              header: "样本/有效",
              enableSorting: false,
              cell: ({ row }) =>
                `${row.original.samples}/${row.original.valid}`,
            },
            {
              id: "median",
              header: "中位收益%",
              enableSorting: false,
              cell: ({ row }) => tradeNumber(row.original.median),
            },
            {
              id: "winRate",
              header: "胜率%",
              enableSorting: false,
              cell: ({ row }) => tradeNumber(row.original.winRate),
            },
            {
              id: "blanks",
              header: "留空",
              enableSorting: false,
              cell: ({ row }) => row.original.blanks,
            },
          ]}
          getRowId={(row) =>
            `${row.group}-${row.strategy}-${row.quality}-${row.horizon}`
          }
          rowCount={data?.length ?? 0}
          pagination={{
            pageIndex: 0,
            pageSize: Math.max(1, data?.length ?? 0),
          }}
          sorting={[]}
          onPaginationChange={() => {}}
          onSortingChange={() => {}}
          showPagination={false}
          emptyMessage={null}
        />
      </div>
    </section>
  );
}
