"use client";

import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import {
  poolCategoryLabels,
  poolSelectionSchema,
  type MarketPoolQuery,
  type MarketPoolRow,
} from "~/lib/market-pool";
import { rpsPeriods } from "~/lib/rps";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DataTable, type DataTableColumn } from "./ui/data-table";
import { IndexBrowser } from "./index-browser";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

export function MarketPoolBrowser({
  symbol,
  disabled,
  onSelect,
}: {
  symbol: string;
  disabled: boolean;
  onSelect: (symbol: string) => void;
}) {
  const [category, setCategory] = useState<
    "all" | keyof typeof poolCategoryLabels
  >("all");
  const [query, setQuery] = useState<MarketPoolQuery>({
    pool: null,
    search: "",
    period: 50,
    minimumRps: null,
    sort: "rps",
    page: 0,
  });
  const [message, setMessage] = useState("");
  const utils = api.useUtils();
  const rpsStatus = api.rpsStatus.useQuery(undefined, {
    refetchInterval: 2000,
  });
  const rpsStart = api.rpsStart.useMutation({
    onSuccess: () => {
      void utils.rpsStatus.invalidate();
    },
    onError: (error) => setMessage(error.message),
  });
  const rpsProgress = rpsStatus.data?.progress;
  useEffect(() => {
    if (rpsProgress?.status === "complete")
      void utils.marketPoolPage.invalidate();
  }, [rpsProgress?.status, rpsProgress?.updatedAt, utils]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pool = poolSelectionSchema.safeParse({
      category: params.get("poolCategory"),
      name: params.get("poolName"),
    });
    if (pool.success) {
      setCategory(pool.data.category);
      setQuery((q) => ({ ...q, pool: pool.data, page: 0 }));
    }
  }, []);
  const catalog = api.marketPoolCatalog.useQuery(
    category === "all" ? "industry" : category,
    { enabled: category !== "all", staleTime: 60000 },
  );
  const ready = category === "all" || query.pool !== null;
  const page = api.marketPoolPage.useQuery(
    { ...query, selected: symbol },
    { enabled: ready },
  );
  const exportRows = api.marketPoolExport.useMutation({
    onSuccess: (data) => {
      const url = URL.createObjectURL(
        new Blob(
          [JSON.stringify({ format: "market-pool-1", ...data }, null, 2)],
          { type: "application/json" },
        ),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `股票池-${data.rps?.date ?? "未计算RPS"}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(
        `已导出${data.rows.length}只股票；导出读取时的名单与RPS证据包含在文件中。`,
      );
    },
    onError: (e) => setMessage(e.message),
  });
  const change = (patch: Partial<MarketPoolQuery>) =>
    setQuery((q) => ({ ...q, ...patch, page: 0 }));
  const rows = ready ? (page.data?.rows ?? []) : [];
  const navigate = (
    neighbor: { symbol: string; page: number } | null | undefined,
  ) => {
    if (!neighbor) return;
    setQuery((q) => ({ ...q, page: neighbor.page }));
    onSelect(neighbor.symbol);
  };
  const columns: DataTableColumn<MarketPoolRow>[] = [
    {
      id: "symbol",
      header: "股票",
      enableSorting: false,
      cell: ({ row }) => (
        <Button
          variant={row.original.symbol === symbol ? "default" : "ghost"}
          disabled={disabled || page.isFetching}
          onClick={() => onSelect(row.original.symbol)}
        >
          {row.original.name} · {row.original.symbol.toUpperCase()}
        </Button>
      ),
    },
    {
      id: "rps",
      header: `全沪深 RPS${query.period}`,
      enableSorting: false,
      cell: ({ row }) => row.original.value?.rps.toFixed(2) ?? "—",
    },
    {
      id: "return",
      header: `${query.period}日后复权涨幅`,
      enableSorting: false,
      cell: ({ row }) =>
        row.original.value
          ? `${(row.original.value.return * 100).toFixed(2)}%`
          : "—",
    },
    {
      id: "status",
      header: "数据状态",
      enableSorting: false,
      cell: ({ row }) =>
        [
          row.original.identity
            ? row.original.identity.status === "delisted"
              ? `已退市（${row.original.identity.date}）`
              : `历史代码，${row.original.identity.date}起变更为${row.original.identity.successor?.toUpperCase()}`
            : null,
          row.original.localDay ? "已扫描到日线" : "未扫描到日线",
          row.original.reason,
        ]
          .filter(Boolean)
          .join("；"),
    },
  ];
  return (
    <section
      className="rounded-lg border border-border bg-card p-4 space-y-3"
      aria-label="股票池浏览"
    >
      <IndexBrowser onSelect={onSelect} disabled={disabled} />
      <h3 className="font-semibold">股票池与强势股浏览</h3>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={category}
          onValueChange={(value) => {
            const next = value as typeof category;
            setCategory(next);
            change({
              pool:
                next === "index"
                  ? { category: "index", name: "中证A500" }
                  : null,
            });
          }}
        >
          <SelectTrigger aria-label="股票池分类">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部沪深</SelectItem>
            {Object.entries(poolCategoryLabels).map(([key, label]) => (
              <SelectItem key={key} value={key}>
                {key === "index" ? "中证A500" : label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {category !== "all" && category !== "index" && (
          <Select
            value={query.pool?.name ?? ""}
            onValueChange={(name) => change({ pool: { category, name } })}
          >
            <SelectTrigger aria-label="选择行业或概念">
              <SelectValue placeholder="选择板块" />
            </SelectTrigger>
            <SelectContent>
              {catalog.data?.names.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Input
          className="w-48"
          aria-label="搜索股票代码或名称"
          placeholder="代码或名称"
          value={query.search}
          onChange={(e) => change({ search: e.target.value })}
        />
        <Select
          value={String(query.period)}
          onValueChange={(value) => change({ period: Number(value) })}
        >
          <SelectTrigger aria-label="RPS周期">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rpsPeriods.map((period) => (
              <SelectItem key={period} value={String(period)}>
                RPS{period}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.minimumRps === null ? "all" : String(query.minimumRps)}
          onValueChange={(value) =>
            change({ minimumRps: value === "all" ? null : Number(value) })
          }
        >
          <SelectTrigger aria-label="RPS过滤">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部成分（含无RPS）</SelectItem>
            {[80, 85, 87, 90, 95].map((n) => (
              <SelectItem key={n} value={String(n)}>
                RPS ≥ {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={query.sort}
          onValueChange={(value) =>
            change({ sort: value as MarketPoolQuery["sort"] })
          }
        >
          <SelectTrigger aria-label="股票排序">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="rps">强度优先</SelectItem>
            <SelectItem value="symbol">代码顺序</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!ready || page.isFetching}
          onClick={() => {
            void page.refetch();
            if (category !== "all") void catalog.refetch();
          }}
        >
          刷新
        </Button>
        <Button
          variant="outline"
          disabled={
            !ready || !page.data || page.isFetching || exportRows.isPending
          }
          onClick={() => exportRows.mutate(query)}
        >
          导出当前筛选
        </Button>
      </div>
      {category !== "all" && catalog.isError && (
        <p role="alert">
          目录读取失败：{catalog.error.message}
          <Button variant="ghost" onClick={() => void catalog.refetch()}>
            重试目录
          </Button>
        </p>
      )}
      {category !== "all" && catalog.isPending && (
        <p role="status">读取板块目录…</p>
      )}
      {category !== "all" && catalog.data?.names.length === 0 && (
        <p role="status">该分类没有名单，请检查配置的Blocks目录。</p>
      )}
      {ready && page.data && (
        <p className="text-sm text-muted-foreground">
          {page.data.rps?.observation && (
            <span>
              {
                ({ noon: "午盘", late: "尾盘", close: "收盘" } as const)[
                  page.data.rps.observation.phase
                ]
              }
              批次 ·{" "}
              {new Date(page.data.rps.observation.createdAt).toLocaleTimeString(
                "zh-CN",
                { timeZone: "Asia/Shanghai", hour12: false },
              )}{" "}
              · 新价覆盖 {(page.data.rps.observation.coverage * 100).toFixed(1)}
              % · 沿用旧价 {page.data.rps.observation.reused} 只 ·{" "}
            </span>
          )}
          RPS基准日：{page.data.rps?.date ?? "未计算"} · 全沪深排名基数：
          {page.data.rps?.count ?? "—"} ·{" "}
          {page.data.rps?.mode === "backfill"
            ? "回填数据（存在生存者偏差）"
            : page.data.rps
              ? "向前数据"
              : "无RPS数据"}
          。列表过滤不改变RPS；文件已扫描不代表行情是最新的。
          {!page.data.source &&
            ` 浏览包含全部本地品种；通达信名称表缺项由交易所历史名录补充，退市及代码变更单独标注，原行情保留。`}
          {page.data.source &&
            ` 当前成分：${page.data.membershipCount}，非沪深A股排除${page.data.excludedMarket}；名单不是历史成分。`}
        </p>
      )}
      {!page.data?.rps && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Button
            type="button"
            disabled={rpsStart.isPending || rpsProgress?.status === "running"}
            onClick={() => rpsStart.mutate({ mode: "backfill", days: 1 })}
          >
            计算最近交易日RPS
          </Button>
          <span>使用本地日线和除权数据计算六个周期。</span>
        </div>
      )}
      {rpsProgress?.status === "running" && (
        <p role="status">
          RPS：{rpsProgress.phase} · {rpsProgress.scanned}/{rpsProgress.total}
        </p>
      )}
      {rpsProgress?.status === "failed" && (
        <p role="alert">RPS计算失败：{rpsProgress.error}</p>
      )}
      {page.data?.source && ready && (
        <details className="text-sm text-muted-foreground">
          <summary>成分来源</summary>
          <p>
            {page.data.source.root} / {page.data.source.file}
          </p>
          <p>SHA256：{page.data.source.hash}</p>
          <p>
            读取时间：{new Date(page.data.source.observedAt).toLocaleString()}
            ；文件时间不是官方名单生效日期。
          </p>
        </details>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={
            disabled || !ready || page.isFetching || !page.data?.previous
          }
          onClick={() => navigate(page.data?.previous)}
        >
          上一只
        </Button>
        <Button
          variant="outline"
          disabled={disabled || !ready || page.isFetching || !page.data?.next}
          onClick={() => navigate(page.data?.next)}
        >
          下一只
        </Button>
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <DataTable
          columns={columns}
          data={rows}
          rowCount={ready ? (page.data?.total ?? 0) : 0}
          pagination={{ pageIndex: query.page, pageSize: 20 }}
          sorting={[]}
          onSortingChange={() => {}}
          onPaginationChange={(updater) =>
            setQuery((q) => ({
              ...q,
              page: (typeof updater === "function"
                ? updater({ pageIndex: q.page, pageSize: 20 })
                : updater
              ).pageIndex,
            }))
          }
          getRowId={(row) => row.symbol}
          label="股票池成分"
          loading={ready && page.isFetching}
          error={ready && page.isError ? page.error.message : undefined}
          onRetry={() => void page.refetch()}
          emptyMessage={
            ready
              ? "没有符合条件的股票，请调整筛选或扫描本地行情。"
              : "请选择行业或概念板块。"
          }
        />
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
