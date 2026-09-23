"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import { rpsPeriods } from "~/lib/rps";
import type { MarketPoolRow } from "~/lib/market-pool";
import { ChartSymbolLink } from "./chart-symbol-link";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

/**
 * 个股 RPS 排名。Reuses the市场股票池 service that already ranks the full 沪深 market
 * against the latest RPS day, so this table and the行情图表页 pool browser can never
 * disagree. Filtering never recomputes ranks: denominators stay full-market.
 */
export function StockRpsRanking() {
  const visible = usePanelVisible();
  const [period, setPeriod] = useState(50);
  const [search, setSearch] = useState("");
  const [minimumRps, setMinimumRps] = useState<number | null>(null);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const page = api.marketPoolPage.useQuery(
    {
      pool: null,
      search,
      period,
      minimumRps,
      sort: "rps",
      page: pagination.pageIndex,
    },
    { enabled: visible, refetchInterval: 10000 },
  );
  const reset =
    <T,>(apply: (value: T) => void) =>
    (value: T) => {
      apply(value);
      setPagination({ pageIndex: 0, pageSize: 20 });
    };
  const columns: DataTableColumn<MarketPoolRow>[] = [
    {
      id: "symbol",
      header: "股票",
      enableSorting: false,
      cell: ({ row }) => (
        <ChartSymbolLink
          symbol={row.original.symbol}
          name={row.original.name}
        />
      ),
    },
    {
      id: "rank",
      header: `RPS${period} 排名`,
      enableSorting: false,
      cell: ({ row }) => row.original.value?.rank ?? "—",
    },
    {
      id: "rps",
      header: `RPS${period}`,
      enableSorting: false,
      cell: ({ row }) => row.original.value?.rps.toFixed(2) ?? "—",
    },
    {
      id: "return",
      header: `${period}日后复权涨幅`,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.value
          ? `${(row.original.value.return * 100).toFixed(2)}%`
          : "—",
    },
    {
      id: "reason",
      header: "未排名原因",
      enableSorting: false,
      cell: ({ row }) => row.original.reason ?? "—",
    },
  ];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-3">
        <label className="space-y-1 text-sm">
          <span className="block">代码或名称</span>
          <Input
            className="w-48"
            aria-label="搜索股票代码或名称"
            placeholder="600519 或 贵州茅台"
            value={search}
            onChange={(e) => reset(setSearch)(e.target.value)}
          />
        </label>
        <Select
          value={String(period)}
          onValueChange={reset((value: string) => setPeriod(Number(value)))}
        >
          <SelectTrigger aria-label="个股RPS周期">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rpsPeriods.map((p) => (
              <SelectItem key={p} value={String(p)}>
                RPS{p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={minimumRps === null ? "all" : String(minimumRps)}
          onValueChange={reset((value: string) =>
            setMinimumRps(value === "all" ? null : Number(value)),
          )}
        >
          <SelectTrigger aria-label="个股RPS过滤">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部证券（含无RPS）</SelectItem>
            {[80, 85, 87, 90, 95].map((n) => (
              <SelectItem key={n} value={String(n)}>
                RPS ≥ {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={page.isFetching}
          onClick={() => void page.refetch()}
        >
          刷新
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        RPS基准日：{page.data?.rps?.date ?? "未计算"} · 全沪深排名基数：
        {page.data?.rps?.count ?? "—"} ·{" "}
        {page.data?.rps?.mode === "backfill"
          ? "回填数据（存在生存者偏差）"
          : page.data?.rps
            ? "向前数据"
            : "无RPS数据"}
        。始终展示最近一个已完成结果日；历史日期的排名请在行情图表页按证券查看RPS曲线。点击股票名跳转到行情图表页查看K线。
      </p>
      <DataTable
        columns={columns}
        data={page.data?.rows ?? []}
        rowCount={page.data?.total ?? 0}
        pagination={pagination}
        onPaginationChange={setPagination}
        sorting={[]}
        onSortingChange={() => {}}
        getRowId={(row) => row.symbol}
        label="个股RPS排名"
        loading={page.isFetching}
        error={page.error?.message}
        onRetry={() => void page.refetch()}
        emptyMessage="没有符合条件的证券，请调整筛选或先计算RPS。"
      />
    </div>
  );
}
