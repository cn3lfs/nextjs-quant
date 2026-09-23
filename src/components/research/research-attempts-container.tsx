"use client";

import { useState } from "react";
import { api } from "~/trpc/react";
import {
  researchAttemptStates,
  type ResearchAttempt,
} from "~/lib/research-governance";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";

const labels: Record<ResearchAttempt["state"], string> = {
  queued: "排队",
  running: "运行",
  succeeded: "成功",
  failed: "失败",
  cancelled: "取消",
  interrupted: "异常中断",
};
const kinds: Record<ResearchAttempt["kind"], string> = {
  backtest: "回测",
  "walk-forward": "滚动验证",
  "formula-screen": "公式选股",
  "sample-research": "样本研究",
  "discipline-counterfactual": "纪律反事实",
};
const columns: DataTableColumn<ResearchAttempt>[] = [
  {
    accessorKey: "createdAt",
    header: "启动时间",
    enableSorting: false,
    cell: ({ row }) => new Date(row.original.createdAt).toLocaleString("zh-CN"),
  },
  {
    accessorKey: "kind",
    header: "研究类型",
    enableSorting: false,
    cell: ({ row }) => kinds[row.original.kind],
  },
  {
    accessorKey: "state",
    header: "状态",
    enableSorting: false,
    cell: ({ row }) => labels[row.original.state],
  },
  {
    id: "range",
    header: "请求区间",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.requestedRange
        ? `${row.original.requestedRange.start}—${row.original.requestedRange.end}`
        : "尚未确定",
  },
  { accessorKey: "taskId", header: "任务标识", enableSorting: false },
  {
    id: "audit",
    header: "记录完整性",
    enableSorting: false,
    cell: ({ row }) =>
      row.original.auditIncomplete ? "审计不完整" : "已记录（历史完整性未知）",
  },
  {
    accessorKey: "error",
    header: "失败或中断原因",
    enableSorting: false,
    cell: ({ row }) => row.original.error ?? "—",
  },
];

export function ResearchAttemptsContainer() {
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [state, setState] = useState<ResearchAttempt["state"] | "all">("all");
  const query = api.researchAttempts.useQuery(
    {
      page: pagination.pageIndex + 1,
      pageSize: pagination.pageSize,
      state: state === "all" ? undefined : state,
    },
    { refetchInterval: 3000 },
  );
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label="研究运行记录"
    >
      <h4 className="font-medium">研究运行记录</h4>
      <p className="text-sm text-muted-foreground">
        全部研究类型与日期，按最近更新排序。尝试次数与成功候选数分开；历史及应用外探索不补造，记录失败时以任务的审计不完整提示为准。
      </p>
      <Select
        value={state}
        onValueChange={(value) => {
          setState(value as typeof state);
          setPagination((p) => ({ ...p, pageIndex: 0 }));
        }}
      >
        <SelectTrigger aria-label="运行状态筛选">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          {researchAttemptStates.map((s) => (
            <SelectItem key={s} value={s}>
              {labels[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DataTable
        columns={columns}
        data={query.data?.items ?? []}
        rowCount={query.data?.total ?? 0}
        pagination={pagination}
        sorting={[]}
        onPaginationChange={setPagination}
        onSortingChange={() => {}}
        getRowId={(row) => row.id}
        label="研究运行记录明细"
        loading={query.isLoading}
        error={query.error?.message}
        onRetry={() => void query.refetch()}
        emptyMessage="尚无符合条件的运行记录。"
      />
    </section>
  );
}
