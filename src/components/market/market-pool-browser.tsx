"use client";
import { useRouter } from "next/navigation";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { rpsPeriods } from "quant-rps";

import { nextTableSort, sortingState } from "~/lib/common/server-sort";
import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import { api } from "~/trpc/react";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { rpsPollInterval } from "./rps-status";
import { MarketPoolAvailabilityNote } from "./market-pool-availability";
import type { BrowseList } from "~/lib/market/browse-list";
import {
  defaultRpsTablePeriods,
  rpsSortColumnId,
  type MarketPoolRow,
} from "~/lib/market/market-pool";
import {
  marketPoolLocationHref,
  type MarketPoolLocation,
  type MarketPoolLocationQuery,
} from "~/lib/market/market-pool-location";
import { isAShareStockSymbol } from "~/lib/market/security-classification";
import {
  batchCandidatesToLabHref,
  portfolioHandoffLimit,
  portfolioHandoffLimitMessage,
  useCandidateBatchSelection,
} from "~/lib/screening/screen-candidate-navigation";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import { Segmented } from "../panels/panel";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { useAccumulatedPages, useTablePage } from "../ui/use-infinite-table";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { usePanelVisible } from "../workbench/keep-alive";
import { IndexBrowser } from "./index-browser";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

const rowKey = (row: MarketPoolRow) => row.symbol;

const categories = [
  { value: "index", label: "指数成分" },
  { value: "industry", label: "行业板块" },
  { value: "concept", label: "概念板块" },
  { value: "all", label: "全部沪深" },
] as const;
const commonIndexLabels = [
  "沪深300",
  "中证500",
  "中证1000",
  "中证A500",
  "上证50",
  "创业板指",
  "科创50",
];
const railLabels = {
  index: "指数",
  industry: "行业",
  concept: "概念",
} as const;

// The TDX catalog qualifies names with their source and code. Keep that
// identity for selection and URLs even when the shortcut shows a short label.
function poolLabel(name: string) {
  return name.replace(/^通达信·[^·]+·/, "");
}

function PoolRail({
  category,
  names,
  selected,
  onSelect,
  children,
}: {
  category: keyof typeof railLabels;
  names?: readonly string[];
  selected?: string;
  onSelect: (name: string) => void;
  children: ReactNode;
}) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const matches = names?.filter((name) => name.toLowerCase().includes(needle));
  const title =
    category === "index" ? "指数成分列表" : railLabels[category] + "板块列表";
  const placeholder = `筛选${railLabels[category]}名称`;
  return (
    <aside
      aria-label={title}
      className="min-w-0 space-y-3 self-start rounded-lg border border-border bg-card p-3"
    >
      <h3 className="font-semibold">{title}</h3>
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {children}
      {!!names?.length && !matches?.length && (
        <p role="status" className="text-sm text-muted-foreground">
          没有匹配的名单
        </p>
      )}
      {!!matches?.length && (
        <ul className="max-h-48 space-y-1 overflow-y-auto p-1 lg:max-h-[32rem]">
          {matches.map((name) => (
            <li key={name}>
              <Button
                type="button"
                variant="plain"
                aria-pressed={name === selected}
                className="w-full rounded-md px-2 py-1.5 text-left text-sm break-all hover:bg-muted aria-pressed:bg-accent aria-pressed:font-semibold aria-pressed:text-primary"
                onClick={() => onSelect(name)}
              >
                {name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

export function MarketPoolBrowser({
  location,
  onLocationChange,
  onSelect,
}: {
  location: MarketPoolLocation;
  onLocationChange: (action: SetStateAction<MarketPoolLocation>) => void;
  /** `browse` carries the current pool so the chart's left rail keeps it. */
  onSelect: (symbol: string, browse?: BrowseList) => void;
}) {
  const router = useRouter();
  const visible = usePanelVisible();
  const { category, query } = location;
  const symbol = query.selected ?? "";
  const setQuery = (action: SetStateAction<MarketPoolLocationQuery>) =>
    onLocationChange((current) => ({
      ...current,
      query: typeof action === "function" ? action(current.query) : action,
    }));
  const [message, setMessage] = useState("");
  // RPS column visibility is page-local UI state; the primary period is forced
  // visible below so choosing RPS1/RPS120 in the period select always shows it.
  const [visibleRpsPeriods, setVisibleRpsPeriods] = useState<number[]>([
    ...defaultRpsTablePeriods,
  ]);
  const sortedPeriod = rpsPeriods.find(
    (p) => query.order?.id === rpsSortColumnId(p),
  );
  const displayedRpsPeriods = useMemo(
    () =>
      [
        ...new Set([
          ...visibleRpsPeriods,
          query.period,
          ...(sortedPeriod ? [sortedPeriod] : []),
        ]),
      ].sort((a, b) => a - b),
    [visibleRpsPeriods, query.period, sortedPeriod],
  );
  const toggleRpsPeriod = (target: number) =>
    setVisibleRpsPeriods((current) =>
      current.includes(target)
        ? current.filter((value) => value !== target)
        : [...current, target].sort((a, b) => a - b),
    );
  const resetKey = JSON.stringify([
    category,
    query.pool,
    query.period,
    query.minimumRps,
    query.search,
    query.sort,
    query.order,
    query.page,
  ]);
  const cursor = useTablePage(resetKey);
  const pageIndex = query.page + cursor.pageIndex;
  const utils = api.useUtils();
  const rpsStatus = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: rpsPollInterval,
  });
  const rpsStart = api.rpsStart.useMutation({
    onSuccess: () => {
      void utils.rpsStatus.invalidate();
    },
    onError: (error) => setMessage(error.message),
  });
  const rpsProgress = rpsStatus.data?.progress;
  useEffect(() => {
    if (rpsProgress?.status === "complete") {
      cursor.restart();
      void utils.marketPoolPage.invalidate();
    }
  }, [rpsProgress?.status, rpsProgress?.updatedAt, utils]);
  const catalog = api.marketPoolCatalog.useQuery(
    category === "all" ? "industry" : category,
    { enabled: visible && category !== "all", staleTime: 60000 },
  );
  const names =
    catalog.data?.category === category ? catalog.data.names : undefined;
  const quickIndices = useMemo(() => {
    if (category !== "index" || !names) return [];
    return commonIndexLabels.flatMap((label) => {
      const name = names.includes(label)
        ? label
        : names.find((name) => poolLabel(name) === label);
      return name ? [{ label, name }] : [];
    });
  }, [category, names]);
  const defaultName =
    quickIndices.find(({ label }) => label === "沪深300")?.name ??
    quickIndices.find(({ label }) => label === "中证A500")?.name ??
    names?.[0];
  useEffect(() => {
    if (!visible || category === "all" || query.pool || !defaultName) return;
    onLocationChange((current) =>
      current.category === category && !current.query.pool
        ? {
            category,
            query: { ...current.query, pool: { category, name: defaultName } },
          }
        : current,
    );
  }, [visible, category, query.pool, defaultName, onLocationChange]);
  const ready = category === "all" || query.pool !== null;
  const page = api.marketPoolPage.useQuery(
    // Only A-share codes are members of a pool; other charts select nothing.
    {
      ...query,
      page: pageIndex,
      // The URL state intentionally has no RPS conditions.
      conditions: [],
      selected: symbolSchema.safeParse(symbol).success ? symbol : undefined,
    },
    { enabled: ready && visible, staleTime: 0 },
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
  const change = (patch: Partial<MarketPoolLocationQuery>) =>
    setQuery((q) => ({ ...q, ...patch, page: 0 }));
  const result =
    ready && page.isSuccess && !page.isPlaceholderData ? page.data : undefined;
  const snapshotKey = `${result?.rps?.date ?? ""}:${result?.rps?.inputHash ?? ""}:${result?.rps?.observation?.createdAt ?? ""}:${result?.source?.hash ?? ""}:${result?.total ?? ""}`;
  const batches = useAccumulatedPages({
    pageIndex: cursor.pageIndex,
    offset: query.page * 20,
    resetKey,
    items: result?.rows,
    total: result?.total,
    snapshotKey,
    onSnapshotDrift: cursor.restart,
    metadata: result,
    getKey: rowKey,
  });
  const { rows, metadata } = batches;
  const batchReady =
    visible && ready && !page.isError && metadata !== undefined;
  const batchSelection = useCandidateBatchSelection(
    batchReady
      ? JSON.stringify([resetKey, metadata.rps, metadata.source?.hash])
      : null,
  );
  const selectedSymbols = batchSelection.symbols.filter((selected) =>
    rows.some((row) => row.symbol === selected),
  );
  const batchHandoff = batchCandidatesToLabHref({
    symbols: selectedSymbols,
    handoffSource: "pool",
    label: query.pool
      ? `股票池 · ${poolLabel(query.pool.name)}`
      : "股票池 · 全部沪深",
    returnTo: marketPoolLocationHref(location),
  });
  const browseLabel =
    query.pool && category !== "all"
      ? `${railLabels[category]} · ${poolLabel(query.pool.name)}`
      : "股票池";
  const browseFor = (target: string): BrowseList => {
    const symbols = metadata?.browseSymbols ?? rows.map((row) => row.symbol);
    const index = symbols.indexOf(target);
    return index >= 0
      ? { label: browseLabel, symbols, index }
      : {
          label: browseLabel,
          symbols: [...symbols, target],
          index: symbols.length,
        };
  };
  const columns: DataTableColumn<MarketPoolRow>[] = [
    {
      id: "portfolio-select",
      header: "勾选",
      enableSorting: false,
      cell: ({ row }) => {
        const { symbol } = row.original;
        if (!batchReady || !isAShareStockSymbol(symbol)) return null;
        const checked = batchSelection.symbols.includes(symbol);
        return (
          <Checkbox
            aria-label={`选择 ${symbol}`}
            checked={checked}
            disabled={
              !checked && batchSelection.symbols.length >= portfolioHandoffLimit
            }
            onCheckedChange={() => batchSelection.toggle(symbol)}
          />
        );
      },
    },
    {
      id: "symbol",
      enableSorting: true,
      header: "股票",
      cell: ({ row }) => (
        <Button
          variant={row.original.symbol === symbol ? "default" : "ghost"}
          disabled={page.isFetching}
          onClick={() => {
            const browse = browseFor(row.original.symbol);
            // Browser Back and reload restore the page containing this row.
            const selectedPage = query.page + Math.floor(row.index / 20);
            if (selectedPage !== query.page)
              setQuery((q) => ({ ...q, page: selectedPage }));
            onSelect(row.original.symbol, browse);
          }}
        >
          {row.original.name} · {row.original.symbol.toUpperCase()}
        </Button>
      ),
    },
    ...displayedRpsPeriods.map((p): DataTableColumn<MarketPoolRow> => ({
      // The primary period keeps the plain "rps" id so the existing default
      // sort highlight is unchanged; every other period sorts server-side by
      // its own full-market column.
      id: p === query.period && p !== sortedPeriod ? "rps" : rpsSortColumnId(p),
      enableSorting: true,
      header: p === query.period ? `RPS${p} (主)` : `RPS${p}`,
      cell: ({ row }) => {
        const metric =
          row.original.rpsValues?.[String(p)] ??
          (p === query.period ? row.original.value : null);
        return (
          <span className="tabular-nums">
            {displayNumber(metric?.rps, 2) ?? "—"}
          </span>
        );
      },
    })),
    {
      id: "return",
      enableSorting: true,
      header: `${query.period}日后复权涨幅`,
      cell: ({ row }) =>
        row.original.value
          ? `${displayNumber(row.original.value.return * 100, 2)}%`
          : "—",
    },
    {
      id: "status",
      enableSorting: true,
      header: "数据状态",
      cell: ({ row }) =>
        [
          row.original.identity
            ? row.original.identity.status === "delisted"
              ? `已退市（${row.original.identity.date}）`
              : `历史代码，${row.original.identity.date}起变更为${row.original.identity.successor?.toUpperCase()}`
            : null,
          row.original.fullDayCache
            ? row.original.localDay
              ? "本地日线及完整包缓存可用"
              : "完整包缓存日线可用"
            : row.original.localDay
              ? "已扫描到日线"
              : metadata?.availability.dailyIndex === "ready"
                ? "未扫描到日线"
                : null,
          metadata?.availability.rps === "ready" ? row.original.reason : null,
        ]
          .filter(Boolean)
          .join("；") || "—",
    },
  ];
  const selectPool = (name: string) => {
    if (category !== "all" && query.pool?.name !== name)
      change({ pool: { category, name } });
  };
  return (
    <section className="min-w-0 space-y-4" aria-label="股票池浏览">
      <header className="space-y-3 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <h2 className="text-lg font-semibold">股票池</h2>
          <Segmented
            label="股票池分类"
            options={categories}
            value={category}
            onChange={(next) => {
              if (next !== category)
                onLocationChange((current) => ({
                  category: next,
                  query: { ...current.query, pool: null, page: 0 },
                }));
            }}
          />
        </div>
        {category === "index" && (
          <>
            {quickIndices.length > 0 && (
              <div
                role="group"
                aria-label="常用指数"
                className="flex flex-wrap items-center gap-2 border-t border-border pt-3"
              >
                <span className="mr-1 text-sm font-medium">常用指数</span>
                {quickIndices.map(({ label, name }) => (
                  <Button
                    key={name}
                    type="button"
                    size="sm"
                    variant={name === query.pool?.name ? "default" : "outline"}
                    aria-pressed={name === query.pool?.name}
                    onClick={() => selectPool(name)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                指数 K 线快捷入口
              </summary>
              <div className="pt-3">
                <IndexBrowser onSelect={onSelect} disabled={false} />
              </div>
            </details>
          </>
        )}
      </header>
      <div
        className={
          category === "all"
            ? "min-w-0"
            : "grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]"
        }
      >
        {category !== "all" && (
          <PoolRail
            key={category}
            category={category}
            names={names}
            selected={query.pool?.name}
            onSelect={selectPool}
          >
            {catalog.isError && (
              <p role="alert">
                目录读取失败：{catalog.error.message}
                <Button variant="ghost" onClick={() => void catalog.refetch()}>
                  重试目录
                </Button>
              </p>
            )}
            {catalog.isPending && <p role="status">正在读取名单目录…</p>}
            {catalog.data?.warnings.map((warning) => (
              <p className="notice" key={warning}>
                {warning}
              </p>
            ))}
            {names?.length === 0 && (
              <p role="status">
                该分类没有名单，请检查配置的 Blocks 目录。
                <Button variant="ghost" onClick={() => void catalog.refetch()}>
                  刷新目录
                </Button>
              </p>
            )}
          </PoolRail>
        )}
        <section
          className="min-w-0 space-y-3 rounded-lg border border-border bg-card p-4"
          aria-label="成分股明细"
        >
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="break-all text-lg font-semibold">
              {category === "all"
                ? "全部沪深成分列表"
                : query.pool
                  ? poolLabel(query.pool.name)
                  : "成分股列表"}
              {metadata && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  · {metadata.membershipCount - metadata.excludedMarket}{" "}
                  只成分股
                </span>
              )}
            </h3>
            {metadata && (query.search.trim() || query.minimumRps !== null) && (
              <span className="text-sm text-muted-foreground">
                筛选命中 {metadata.total} 只
              </span>
            )}
          </header>
          <div className="flex flex-wrap items-center gap-2">
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
                    {rpsPeriodLabel(period)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">
                  RPS列 · {displayedRpsPeriods.length}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                aria-label="选择显示的RPS列"
                className="w-60 space-y-2"
              >
                <p className="text-sm font-medium">显示 RPS 列</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                  {rpsPeriods.map((p) => (
                    <label
                      key={p}
                      className="flex items-center gap-1.5 text-sm"
                    >
                      <Checkbox
                        checked={displayedRpsPeriods.includes(p)}
                        disabled={p === query.period || p === sortedPeriod}
                        onCheckedChange={() => toggleRpsPeriod(p)}
                      />
                      RPS{p}
                      {p === query.period ? " (主)" : ""}
                    </label>
                  ))}
                </div>
                <div className="flex items-center gap-1 border-t border-border pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    title="恢复默认列 RPS3/5/10/20/50"
                    onClick={() =>
                      setVisibleRpsPeriods([...defaultRpsTablePeriods])
                    }
                  >
                    默认
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    title="显示全部 RPS 周期"
                    onClick={() => setVisibleRpsPeriods([...rpsPeriods])}
                  >
                    全选
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <Select
              value={
                query.minimumRps === null ? "all" : String(query.minimumRps)
              }
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
                change({
                  sort: value as MarketPoolLocationQuery["sort"],
                  order: null,
                })
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
                if (query.page > 0) change({});
                else if (cursor.pageIndex > 0) cursor.restart();
                else void page.refetch();
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
              onClick={() => exportRows.mutate({ ...query, conditions: [] })}
            >
              导出当前筛选
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!batchHandoff}
              onClick={() =>
                batchHandoff &&
                router.push(batchHandoff.href, { scroll: false })
              }
            >
              批量带入组合诊断 ({selectedSymbols.length}/{portfolioHandoffLimit}
              )
            </Button>
            {batchSelection.symbols.length === portfolioHandoffLimit && (
              <span className="text-sub text-nc-text-3">
                {portfolioHandoffLimitMessage}
              </span>
            )}
          </div>
          <div className="max-h-[32rem] overflow-auto">
            <DataTable
              columns={columns}
              data={rows}
              rowCount={batches.total}
              infiniteScroll={{
                hasMore: batches.hasMore,
                startOffset: query.page * 20,
                loadingMore: pageIndex > 0 && page.isFetching,
                onLoadMore: cursor.loadMore,
              }}
              sorting={sortingState(query.order)}
              onSortingChange={(updater) =>
                change({ order: nextTableSort(updater, query.order) })
              }
              getRowId={rowKey}
              label="股票池成分"
              loading={ready && page.isFetching}
              error={ready && page.isError ? page.error.message : undefined}
              onRetry={() => void page.refetch()}
              emptyMessage={
                ready
                  ? "没有符合条件的股票，请调整筛选或扫描本地行情。"
                  : "请选择要浏览的股票池。"
              }
            />
          </div>
          {ready && metadata && (
            <p className="text-sm text-muted-foreground">
              {metadata.rps?.observation && (
                <span>
                  {
                    ({ noon: "午盘", late: "尾盘", close: "收盘" } as const)[
                      metadata.rps.observation.phase
                    ]
                  }
                  批次 ·{" "}
                  {new Date(
                    metadata.rps.observation.createdAt,
                  ).toLocaleTimeString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                  })}{" "}
                  · 新价覆盖{" "}
                  {displayNumber(metadata.rps.observation.coverage * 100, 1)}% ·
                  沿用旧价 {metadata.rps.observation.reused} 只 ·{" "}
                </span>
              )}
              RPS基准日：{metadata.rps?.date ?? "未计算"} · 全沪深排名基数：
              {metadata.rps?.count ?? "—"} ·{" "}
              {metadata.rps?.mode === "backfill"
                ? "回填数据"
                : metadata.rps
                  ? "向前数据"
                  : "无RPS数据"}
              。列表过滤不改变RPS；文件已扫描不代表行情是最新的。
              {!metadata.source &&
                ` 浏览包含全部本地品种；通达信名称表缺项由交易所历史名录补充，退市及代码变更单独标注，原行情保留。`}
              {metadata.source && ` · 当前成分：${metadata.membershipCount} 只`}
            </p>
          )}
          {ready && metadata && (
            <MarketPoolAvailabilityNote
              availability={metadata.availability}
              period={query.period}
              showDailyIndex
            />
          )}
          {ready && metadata && !metadata.rps && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <Button
                type="button"
                disabled={
                  rpsStart.isPending || rpsProgress?.status === "running"
                }
                onClick={() => rpsStart.mutate({ mode: "backfill", days: 1 })}
              >
                计算最近交易日RPS
              </Button>
              <span>
                使用本地日线和除权数据计算 {rpsPeriods.length} 个周期。
              </span>
            </div>
          )}
          {rpsProgress?.status === "running" && (
            <p role="status">
              RPS：{rpsProgress.phase} · {rpsProgress.scanned}/
              {rpsProgress.total}
            </p>
          )}
          {rpsProgress?.status === "failed" && (
            <p role="alert">RPS计算失败：{rpsProgress.error}</p>
          )}
          {rpsProgress?.status === "waiting" && (
            <p role="status">RPS等待条件：{rpsProgress.waiting?.message}</p>
          )}
          {metadata?.source && ready && (
            <details className="text-sm text-muted-foreground">
              <summary>成分来源</summary>
              {"classification" in metadata.source && (
                <p>
                  分类口径：
                  {metadata.source.classification === "tdx-research"
                    ? "通达信研究行业"
                    : metadata.source.classification === "tdx-concept"
                      ? "通达信概念"
                      : "通达信指数成分"}
                </p>
              )}
              <p>
                {metadata.source.root} / {metadata.source.file}
              </p>
              <p>SHA256：{metadata.source.hash}</p>
              <p>
                读取时间：
                {new Date(metadata.source.observedAt).toLocaleString()}
                ；文件时间不是官方名单生效日期。
              </p>
            </details>
          )}
          {message && <p role="status">{message}</p>}
        </section>
      </div>
    </section>
  );
}
