"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { rpsPeriods } from "quant-rps";

import {
  nextTableSort,
  sortingState,
  type TableSort,
} from "~/lib/common/server-sort";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import {
  batchCandidatesToLabHref,
  portfolioHandoffLimit,
  portfolioHandoffLimitMessage,
  rpsCandidateToLabHref,
  useCandidateBatchSelection,
} from "~/lib/screening/screen-candidate-navigation";
import {
  rpsConditionsSchema,
  type RpsCondition,
} from "~/lib/screening/rps-conditions";
import {
  defaultRpsTablePeriods,
  marketPoolQuerySchema,
  rpsSortColumnId,
  type MarketPoolRow,
} from "~/lib/market/market-pool";
import { ChartSymbolLink } from "./chart-symbol-link";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { useAccumulatedPages } from "../ui/use-infinite-table";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { usePanelVisible } from "../workbench/keep-alive";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { BrowseSource } from "./open-chart";
import { MarketPoolAvailabilityNote } from "./market-pool-availability";
import { RpsConditionEditor } from "./rps-condition-editor";
import {
  FilterDivider,
  FilterGroup,
  FilterToolbar,
  MethodologyPopover,
} from "../panels";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

const rowKey = (row: MarketPoolRow) => row.symbol;
const pageSize = 20;

export function recoverRpsPage(page: number, rowCount: number, total: number) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  return rowCount === 0 && total > 0 && page > lastPage ? lastPage : null;
}
type RankingFilters = {
  period: number;
  search: string;
  conditions: RpsCondition[];
  order: TableSort;
};
const rankingSortColumns = new Set([
  "symbol",
  "rank",
  "rps",
  "return",
  "reason",
]);

function readRankingFilters(query: string | null): RankingFilters {
  const params = new URLSearchParams(query ?? "");
  const fields = marketPoolQuerySchema.shape;
  const sortPeriod = fields.period.safeParse(Number(params.get("sortPeriod")));
  const sortColumn = params.get("sortColumn") ?? "";
  const sortId = sortPeriod.success
    ? rpsSortColumnId(sortPeriod.data)
    : rankingSortColumns.has(sortColumn)
      ? sortColumn
      : null;
  const conditions = params.getAll("rpsCondition").map((condition) => {
    const [period, side, value] = condition.split(",");
    return { period: Number(period), side, value: Number(value) };
  });
  return {
    period: fields.period.catch(50).parse(Number(params.get("period"))),
    search: (params.get("search") ?? "").slice(0, 80),
    conditions: rpsConditionsSchema.safeParse(conditions).data ?? [],
    order: sortId
      ? { id: sortId, desc: params.get("descending") === "true" }
      : null,
  };
}

function rpsRankingHref(
  { period, search, conditions, order }: RankingFilters,
  columns: readonly number[] | undefined,
  page: number,
) {
  const params = new URLSearchParams({ tab: "rps", period: String(period) });
  if (search) params.set("search", search);
  for (const condition of conditions)
    params.append(
      "rpsCondition",
      `${condition.period},${condition.side},${condition.value}`,
    );
  if (order) {
    // The allowlisted return URL never embeds a scheme-like `rps:<period>` value.
    const sortPeriod = rpsPeriods.find((p) => rpsSortColumnId(p) === order.id);
    if (sortPeriod) params.set("sortPeriod", String(sortPeriod));
    else params.set("sortColumn", order.id);
    params.set("descending", String(order.desc));
  }
  if (columns) params.set("rpsCols", columns.join(","));
  if (page > 1) params.set("page", String(page));
  return `/scan?${params}`;
}

/** Visible RPS columns, with the primary and sorted period always included so
 *  a restored URL can never hide the column the table is ranked by. */
export function mergeRpsColumns(
  columns: readonly number[],
  period: number,
  sortedPeriod: number | undefined,
) {
  const allowed = new Set<number>(rpsPeriods);
  const merged = new Set<number>();
  for (const value of columns) if (allowed.has(value)) merged.add(value);
  merged.add(period);
  if (sortedPeriod !== undefined) merged.add(sortedPeriod);
  return [...merged].sort((a, b) => a - b);
}

/** `rpsCols` + one-based `page`; page 1 is omitted from the URL. */
export function readRpsTableState(
  query: string | null,
  period: number,
  sortedPeriod: number | undefined,
) {
  const params = new URLSearchParams(query ?? "");
  const columns = (params.get("rpsCols") ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => (rpsPeriods as readonly number[]).includes(value));
  const pageParam = params.get("page") ?? "";
  const page = /^\d+$/.test(pageParam) ? Number(pageParam) : 1;
  return {
    columns: mergeRpsColumns(
      columns.length ? columns : defaultRpsTablePeriods,
      period,
      sortedPeriod,
    ),
    page: marketPoolQuerySchema.shape.page.safeParse(page - 1).success
      ? page
      : 1,
  };
}

function writeRpsTableUrl(href: string) {
  if (
    window.location.pathname === "/scan" &&
    new URLSearchParams(window.location.search).get("tab") === "rps" &&
    href !== window.location.pathname + window.location.search
  )
    window.history.replaceState(null, "", href + window.location.hash);
}

const rpsRankingMethodology = [
  {
    label: "排名口径",
    detail:
      "各条件来自同一批次，过滤不重新排名，排名分母始终是全市场。条件命中数只来自当前条件的成功查询结果。",
  },
  {
    label: "基准日",
    detail:
      "始终展示最近一个已完成结果日；历史日期的排名请在行情图表页按证券查看 RPS 曲线。",
  },
  {
    label: "换股",
    detail:
      "点击股票名跳转到行情图表页查看 K 线；图表中 PageUp/PageDown 按已加载列表的顺序换股。",
  },
  {
    label: "结果语义",
    detail:
      "批次、基数与命中数只来自当前条件的成功查询结果；草稿修改不会改变上表。",
  },
];

/** 「带入回测」 may only be emitted from a settled, current page. A refetch or a
 *  placeholder page still carries rows from an earlier query key or an earlier
 *  batch, so its frozen date must not become an actionable handoff. */
export function rpsHandoffRowAvailable(state: {
  visible: boolean;
  rankingReady: boolean;
  isFetching: boolean;
  isPlaceholderData: boolean;
  isError: boolean;
  conditionUnavailable: boolean;
}): boolean {
  return (
    state.visible &&
    state.rankingReady &&
    !state.isFetching &&
    !state.isPlaceholderData &&
    !state.isError &&
    !state.conditionUnavailable
  );
}

/** A close observation is only a confirmed persistent close when the same day
 *  also exists in the RPS store; otherwise it is still a close-time snapshot. */
function observationLabel(
  phase: "noon" | "late" | "close",
  persisted: boolean,
) {
  return phase === "close"
    ? persisted
      ? "收盘批次"
      : "收盘观察批次"
    : phase === "noon"
      ? "午盘观察批次（非收盘定稿）"
      : "尾盘观察批次（非收盘定稿）";
}

/**
 * 个股 RPS 排名。Reuses the市场股票池 service that already ranks the full 沪深 market
 * against the latest RPS day, so this table and the行情图表页 pool browser can never
 * disagree. Filtering never recomputes ranks: denominators stay full-market.
 */
export function StockRpsRanking() {
  const visible = usePanelVisible();
  const router = useRouter();
  const route = useSearchParams();
  const linked =
    visible && route.get("tab") === "rps" ? route.toString() : null;
  const [retainedLink, setRetainedLink] = useState(linked);
  if (linked !== null && linked !== retainedLink) setRetainedLink(linked);
  const link = linked ?? retainedLink;
  const filters = useMemo(() => readRankingFilters(link), [link]);
  const { period, search, conditions, order } = filters;
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const sortedPeriod = rpsPeriods.find((p) => order?.id === rpsSortColumnId(p));
  const { columns: displayedRpsPeriods, page: linkedPage } = readRpsTableState(
    link,
    period,
    sortedPeriod,
  );
  const filterKey = JSON.stringify(filters);
  const [cursor, setCursor] = useState({
    filterKey,
    linkedPage,
    startPage: linkedPage,
    offset: 0,
  });
  // A newly completed page updates the URL while keeping the loaded prefix.
  // An external link starts at its own page and does not replay that prefix.
  const position =
    cursor.filterKey !== filterKey ||
    (cursor.linkedPage !== linkedPage &&
      cursor.startPage + cursor.offset !== linkedPage)
      ? { filterKey, linkedPage, startPage: linkedPage, offset: 0 }
      : cursor.linkedPage !== linkedPage
        ? { ...cursor, linkedPage }
        : cursor;
  if (position !== cursor) setCursor(position);
  const { startPage, offset } = position;
  const pageIndex = startPage - 1 + offset;
  const resetKey = JSON.stringify([filterKey, startPage]);
  const explicitColumns = new URLSearchParams(link ?? "").has("rpsCols");
  const returnTo = rpsRankingHref(
    filters,
    explicitColumns ? displayedRpsPeriods : undefined,
    linkedPage,
  );
  const updateFilters = (patch: Partial<RankingFilters>) => {
    const next = { ...filters, ...patch };
    const nextSort = rpsPeriods.find(
      (p) => next.order?.id === rpsSortColumnId(p),
    );
    writeRpsTableUrl(
      rpsRankingHref(
        next,
        explicitColumns
          ? mergeRpsColumns(displayedRpsPeriods, next.period, nextSort)
          : undefined,
        1,
      ),
    );
  };
  const updateColumns = (next: number[]) =>
    writeRpsTableUrl(
      rpsRankingHref(
        filters,
        mergeRpsColumns(next, period, sortedPeriod),
        linkedPage,
      ),
    );
  const toggleRpsPeriod = (target: number) =>
    updateColumns(
      displayedRpsPeriods.includes(target)
        ? displayedRpsPeriods.filter((value) => value !== target)
        : [...displayedRpsPeriods, target],
    );
  // Ranks only change when an RPS batch writes a new day: poll while one runs.
  const job = api.rpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 5000,
  });
  const running = job.data?.progress?.status === "running";
  const page = api.marketPoolPage.useQuery(
    {
      pool: null,
      search,
      period,
      minimumRps: null,
      conditions,
      sort: "rps",
      order,
      page: pageIndex,
    },
    {
      enabled: visible,
      staleTime: 0,
      refetchInterval: running && offset === 0 ? 10000 : false,
    },
  );
  // Only a successful response for the current query key is evidence for this
  // page. A same-key refetch keeps it; a key change or a failed refresh does not.
  const result =
    page.isSuccess && !page.isPlaceholderData ? page.data : undefined;
  const recoveryPage =
    visible && result && !page.isFetching
      ? recoverRpsPage(pageIndex + 1, result.rows.length, result.total)
      : null;
  const snapshotKey = `${result?.rps?.date ?? ""}:${result?.rps?.inputHash ?? ""}:${result?.rps?.observation?.createdAt ?? ""}`;
  const restart = () => {
    setCursor({ ...position, offset: 0 });
    writeRpsTableUrl(rpsRankingHref(filters, displayedRpsPeriods, startPage));
  };
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: offset,
    items: result?.rows,
    total: result?.total,
    isSuccess: !page.isFetching && recoveryPage === null,
    snapshotKey,
    onSnapshotDrift: restart,
    pageSize,
    metadata: result,
    offset: (startPage - 1) * pageSize,
    getKey: rowKey,
  });
  const rawUrlPage = new URLSearchParams(link ?? "").get("page");
  const expectedUrlPage = pageIndex === 0 ? null : String(pageIndex + 1);
  const normalizeUrlPage =
    visible &&
    result &&
    !page.isFetching &&
    recoveryPage === null &&
    rawUrlPage !== null &&
    rawUrlPage !== expectedUrlPage;
  const completedHref =
    visible &&
    offset > 0 &&
    result &&
    batches.metadata === result &&
    !page.isFetching
      ? rpsRankingHref(filters, displayedRpsPeriods, pageIndex + 1)
      : null;
  useEffect(() => {
    if (recoveryPage === null && !completedHref && !normalizeUrlPage) return;
    const params = new URLSearchParams(window.location.search);
    if (params.toString() !== link) return;
    if (recoveryPage !== null) {
      setCursor({ filterKey, linkedPage, startPage: recoveryPage, offset: 0 });
      if (recoveryPage === 1) params.delete("page");
      else params.set("page", String(recoveryPage));
      writeRpsTableUrl(`/scan?${params}`);
    } else if (completedHref) {
      writeRpsTableUrl(completedHref);
    } else if (normalizeUrlPage) {
      if (expectedUrlPage === null) params.delete("page");
      else params.set("page", expectedUrlPage);
      writeRpsTableUrl(`/scan?${params}`);
    }
  }, [
    completedHref,
    expectedUrlPage,
    link,
    filterKey,
    linkedPage,
    normalizeUrlPage,
    recoveryPage,
  ]);
  const confirmed = page.isError ? undefined : batches.metadata;
  function refresh() {
    if (offset === 0) void page.refetch();
    else restart();
  }
  const rankingReady = confirmed?.availability.rps === "ready";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  });
  const appliedText = conditions.length
    ? conditions
        .map(
          (condition) =>
            `${rpsPeriodLabel(condition.period)} ${condition.side === "gte" ? "≥" : "≤"} ${condition.value}`,
        )
        .join(" 且 ")
    : "无 RPS 条件（全部沪深，含无RPS）";
  // A missing condition period or no batch cannot be read as a real 0-hit result.
  const unavailablePeriods =
    conditions.length > 0 && confirmed
      ? !confirmed.rps
        ? ["当前数据源无 RPS 批次"]
        : confirmed.rps.conditions
          ? confirmed.rps.conditions
              .filter((condition) => condition.periodMissing)
              .map(
                (condition) =>
                  `当前批次未计算 ${rpsPeriodLabel(condition.period)}`,
              )
          : ["当前批次缺少条件周期信息"]
      : [];
  const conditionUnavailable = unavailablePeriods.length > 0;
  const conditionCounts = confirmed?.rps?.conditions ?? [];
  const handoffBatch = rpsHandoffRowAvailable({
    visible,
    rankingReady,
    isFetching: page.isFetching,
    isPlaceholderData: page.isPlaceholderData,
    isError: page.isError,
    conditionUnavailable,
  })
    ? confirmed
    : undefined;
  const batchReady = !!handoffBatch?.rps?.date && handoffBatch === result;
  const batchSelection = useCandidateBatchSelection(
    batchReady
      ? JSON.stringify([
          resetKey,
          pageIndex,
          snapshotKey,
          job.data?.progress?.id,
          page.dataUpdatedAt,
        ])
      : null,
  );
  const batchRows = new Set(batchReady ? result.rows.map(rowKey) : []);
  const batchHandoff = batchCandidatesToLabHref({
    symbols: batchSelection.symbols,
    handoffSource: "rps",
    label: rpsPeriodLabel(period),
    frozenDate: handoffBatch?.rps?.date,
    returnTo,
  });
  const batchFull = batchSelection.symbols.length >= portfolioHandoffLimit;
  const columns: DataTableColumn<MarketPoolRow>[] = [
    ...(batchReady
      ? [
          {
            id: "portfolio-select",
            enableSorting: false,
            header: "勾选",
            cell: ({ row }) => {
              const { symbol } = row.original;
              if (!batchRows.has(symbol)) return null;
              const checked = batchSelection.symbols.includes(symbol);
              const disabled = batchFull && !checked;
              return (
                <span
                  className="inline-flex items-center gap-1"
                  title={disabled ? portfolioHandoffLimitMessage : undefined}
                >
                  <Checkbox
                    aria-label={`选择 ${symbol}`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={() => batchSelection.toggle(symbol)}
                  />
                  {disabled && <small>{portfolioHandoffLimitMessage}</small>}
                </span>
              );
            },
          } satisfies DataTableColumn<MarketPoolRow>,
        ]
      : []),
    {
      id: "symbol",
      enableSorting: true,
      header: "股票",
      cell: ({ row }) => (
        <ChartSymbolLink
          symbol={row.original.symbol}
          name={row.original.name}
        />
      ),
    },
    {
      id: "rank",
      enableSorting: true,
      header: `RPS${period} 排名`,
      cell: ({ row }) => row.original.value?.rank ?? "—",
    },
    ...displayedRpsPeriods.map((p): DataTableColumn<MarketPoolRow> => ({
      // The primary period keeps the plain "rps" id so the server's default
      // rank sort stays highlighted; other periods sort by their own column.
      id: p === period && p !== sortedPeriod ? "rps" : rpsSortColumnId(p),
      enableSorting: true,
      header: `RPS${p}`,
      cell: ({ row }) => {
        const metric =
          row.original.rpsValues?.[String(p)] ??
          (p === period ? row.original.value : null);
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
      header: `${period}日后复权涨幅`,
      cell: ({ row }) =>
        row.original.value
          ? `${displayNumber(row.original.value.return * 100, 2)}%`
          : "—",
    },
    {
      id: "lab",
      enableSorting: false,
      header: "操作",
      cell: ({ row }) => {
        if (!handoffBatch?.rps?.date) return null;
        const href = rpsCandidateToLabHref({
          symbol: row.original.symbol,
          frozenDate: handoffBatch.rps.date,
          period: handoffBatch.period,
          rpsValue: row.original.value?.rps,
          returnTo,
        });
        return href ? (
          <Button asChild size="sm" variant="ghost">
            <Link href={href} prefetch={false} scroll={false}>
              带入回测
            </Link>
          </Button>
        ) : null;
      },
    },
    ...(conditions.length
      ? [
          {
            id: "conditionValues",
            enableSorting: false,
            header: "条件 RPS",
            cell: ({ row }) => (
              <span className="whitespace-nowrap tabular-nums">
                {conditions
                  .map(
                    (condition) =>
                      `${rpsPeriodLabel(condition.period)} ${displayNumber(
                        row.original.conditionValues?.[String(condition.period)]
                          ?.rps,
                        2,
                      )}`,
                  )
                  .join(" · ")}
              </span>
            ),
          } satisfies DataTableColumn<MarketPoolRow>,
        ]
      : []),
    ...(rankingReady
      ? [
          {
            id: "reason",
            enableSorting: true,
            header: "未排名原因",
            cell: ({ row }) => row.original.reason ?? "—",
          } satisfies DataTableColumn<MarketPoolRow>,
        ]
      : []),
  ];
  return (
    <div className="space-y-3">
      <FilterToolbar label="个股 RPS 筛选">
        <FilterGroup>
          <Select
            value={String(period)}
            onValueChange={(value) => updateFilters({ period: Number(value) })}
          >
            <SelectTrigger
              size="sm"
              aria-label="个股RPS周期"
              className="w-28 shrink-0"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rpsPeriods.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {rpsPeriodLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FilterGroup>
        <FilterGroup>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
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
                  <label key={p} className="flex items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={displayedRpsPeriods.includes(p)}
                      disabled={p === period || p === sortedPeriod}
                      onCheckedChange={() => toggleRpsPeriod(p)}
                    />
                    RPS{p}
                    {p === period ? " (主)" : ""}
                  </label>
                ))}
              </div>
              <div className="flex items-center gap-1 border-t border-border pt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  title="恢复默认列 RPS3/5/10/20/50"
                  onClick={() => updateColumns([...defaultRpsTablePeriods])}
                >
                  默认
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  title="显示全部 RPS 周期"
                  onClick={() => updateColumns([...rpsPeriods])}
                >
                  全选
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </FilterGroup>
        <FilterGroup>
          <Input
            className="h-8 w-44"
            aria-label="搜索股票代码或名称"
            placeholder="搜代码/名称"
            maxLength={80}
            value={search}
            onChange={(e) => updateFilters({ search: e.target.value })}
          />
        </FilterGroup>
        <Popover open={conditionsOpen} onOpenChange={setConditionsOpen}>
          <PopoverTrigger asChild>
            <Button
              variant={conditions.length ? "default" : "outline"}
              size="sm"
            >
              RPS 条件{conditions.length ? ` · ${conditions.length}` : ""}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[24rem]">
            <RpsConditionEditor
              applied={conditions}
              onApply={(next) => {
                updateFilters({ conditions: next });
                setConditionsOpen(false);
              }}
              onClear={() => {
                updateFilters({ conditions: [] });
                setConditionsOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <FilterDivider />
        <Button
          variant="outline"
          size="sm"
          disabled={page.isFetching}
          onClick={refresh}
        >
          刷新
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={order === null}
          onClick={() => updateFilters({ order: null })}
        >
          重置排序
        </Button>
        <FilterDivider />
        <Button
          size="sm"
          variant="outline"
          disabled={!batchHandoff}
          onClick={() => {
            if (batchHandoff) router.push(batchHandoff.href, { scroll: false });
          }}
        >
          {`批量带入组合诊断 (${batchSelection.symbols.length}/${portfolioHandoffLimit})`}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!batchHandoff}
          onClick={batchSelection.clear}
        >
          清空已选
        </Button>
        <div className="ml-auto shrink-0">
          <MethodologyPopover
            title="个股 RPS 口径"
            items={rpsRankingMethodology}
          />
        </div>
      </FilterToolbar>
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <span>
          已生效条件：
          <span className="text-foreground">{appliedText}</span>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {conditionUnavailable
            ? "条件不可用"
            : confirmed
              ? `命中 ${confirmed.total} 只`
              : "等待当前条件的成功查询结果"}
        </span>
        {confirmed && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              RPS基准日：{confirmed.rps?.date ?? "未计算"} · 展示周期{" "}
              {rpsPeriodLabel(confirmed.period)} 排名基数：
              {confirmed.rps?.count ?? "—"} ·{" "}
              {confirmed.rps?.mode === "backfill"
                ? "回填数据"
                : confirmed.rps
                  ? "向前数据"
                  : "无RPS数据"}
            </span>
          </>
        )}
        {page.isFetching && <span role="status">正在刷新…</span>}
      </div>
      {conditionCounts.length > 0 && (
        <p className="text-xs text-muted-foreground">
          条件周期有效排名基数：
          {conditionCounts
            .map(
              (condition) =>
                `${rpsPeriodLabel(condition.period)} ${
                  condition.count === null ? "未计算" : condition.count
                }`,
            )
            .join(" / ")}
        </p>
      )}
      {confirmed?.rps?.observation && (
        <p className="text-xs text-muted-foreground">
          {observationLabel(
            confirmed.rps.observation.phase,
            confirmed.rps.observation.persistedClose === true,
          )}{" "}
          ·{" "}
          {new Date(confirmed.rps.observation.createdAt).toLocaleTimeString(
            "zh-CN",
            {
              timeZone: "Asia/Shanghai",
              hour12: false,
            },
          )}{" "}
          · 新价覆盖{" "}
          {displayNumber(confirmed.rps.observation.coverage * 100, 1)}% ·
          沿用旧价 {confirmed.rps.observation.reused} 只 · 缺失{" "}
          {confirmed.rps.observation.missing} 只。
        </p>
      )}
      {confirmed && (
        <MarketPoolAvailabilityNote
          availability={confirmed.availability}
          period={confirmed.period}
        />
      )}
      {conditionUnavailable && (
        <p role="status" className="text-sm text-muted-foreground">
          条件不可用：{unavailablePeriods.join("；")}
          。含这些周期的条件不会命中任何证券；这不表示真实筛选结果为 0
          只，需要包含该周期的新批次或先计算 RPS。可清除条件恢复完整列表。
        </p>
      )}
      <BrowseSource
        origin="stock-rps"
        label={
          rankingReady
            ? `RPS${confirmed?.period}排名${confirmed?.rps?.date ? ` · ${confirmed.rps.date}` : ""}`
            : `RPS${confirmed?.period ?? period} 列表`
        }
        symbols={
          conditionUnavailable ? [] : batches.rows.map((row) => row.symbol)
        }
      >
        <DataTable
          columns={columns}
          data={
            conditionUnavailable || (page.isError && offset === 0)
              ? []
              : batches.rows
          }
          rowCount={conditionUnavailable ? undefined : confirmed?.total}
          sorting={sortingState(order)}
          onSortingChange={(updater) =>
            updateFilters({ order: nextTableSort(updater, order) })
          }
          getRowId={rowKey}
          label="个股RPS排名"
          loading={page.isFetching || page.isPending || recoveryPage !== null}
          error={page.error?.message}
          onRetry={() => void page.refetch()}
          infiniteScroll={{
            hasMore:
              !conditionUnavailable &&
              batches.hasMore &&
              marketPoolQuerySchema.shape.page.safeParse(pageIndex + 1).success,
            loadingMore: offset > 0 && page.isFetching,
            startOffset: (startPage - 1) * pageSize,
            onLoadMore: () => {
              setCursor((current) =>
                current === position
                  ? { ...position, offset: offset + 1 }
                  : current,
              );
            },
          }}
          emptyMessage={
            conditionUnavailable
              ? "条件不可用：当前批次未计算所需周期，条件没有执行；这不表示筛选结果为 0。"
              : conditions.length
                ? "没有同时满足全部条件的证券。可放宽阈值、改选周期，或确认当前批次是否计算了这些周期。"
                : "没有符合条件的证券，请调整筛选或先计算RPS。"
          }
        />
      </BrowseSource>
    </div>
  );
}
