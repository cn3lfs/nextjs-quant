"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { rpsPeriods } from "quant-rps";

import {
  nextTableSort,
  sortingState,
  type TableSort,
} from "~/lib/common/server-sort";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import type { RpsCondition } from "~/lib/screening/rps-conditions";
import type { MarketPoolRow } from "~/lib/market/market-pool";
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
      "点击股票名跳转到行情图表页查看 K 线；图表中 PageUp/PageDown 按本页顺序换股。",
  },
  {
    label: "结果语义",
    detail:
      "批次、基数、命中数与分页只来自当前条件的成功查询结果；草稿修改不会改变上表。",
  },
];

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
  const [period, setPeriod] = useState(50);
  const [search, setSearch] = useState("");
  // Applied conditions are the only ones in the query key; draft edits wait for
  // 「应用条件」 so typing a threshold cannot produce a request per keystroke.
  const [conditions, setConditions] = useState<RpsCondition[]>([]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 20 });
  const [order, setOrder] = useState<TableSort>(null);
  const [conditionsOpen, setConditionsOpen] = useState(false);
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
      page: pagination.pageIndex,
    },
    {
      enabled: visible,
      refetchInterval: running ? 10000 : false,
    },
  );
  // Only a successful response for the current query key is evidence for this
  // page. A same-key refetch keeps it; a key change or a failed refresh does not.
  const confirmed = page.isSuccess ? page.data : undefined;
  const rankingReady = confirmed?.availability.rps === "ready";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void page.refetch();
    wasRunning.current = running;
  }, [running, page]);
  const reset =
    <T,>(apply: (value: T) => void) =>
    (value: T) => {
      apply(value);
      setPagination({ pageIndex: 0, pageSize: 20 });
    };
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
  const columns: DataTableColumn<MarketPoolRow>[] = [
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
    {
      id: "rps",
      enableSorting: true,
      header: `RPS${period}`,
      cell: ({ row }) => displayNumber(row.original.value?.rps, 2) ?? "—",
    },
    {
      id: "return",
      enableSorting: true,
      header: `${period}日后复权涨幅`,
      cell: ({ row }) =>
        row.original.value
          ? `${displayNumber(row.original.value.return * 100, 2)}%`
          : "—",
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
            onValueChange={reset((value: string) => setPeriod(Number(value)))}
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
          <Input
            className="h-8 w-44"
            aria-label="搜索股票代码或名称"
            placeholder="搜代码/名称"
            value={search}
            onChange={(e) => reset(setSearch)(e.target.value)}
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
                setConditions(next);
                setPagination({ pageIndex: 0, pageSize: 20 });
                setConditionsOpen(false);
              }}
              onClear={() => {
                setConditions([]);
                setPagination({ pageIndex: 0, pageSize: 20 });
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
          onClick={() => void page.refetch()}
        >
          刷新
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={order === null}
          onClick={() => reset(setOrder)(null)}
        >
          重置排序
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
                ? "回填数据（存在生存者偏差）"
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
          conditionUnavailable
            ? []
            : (confirmed?.rows ?? []).map((row) => row.symbol)
        }
      >
        <DataTable
          columns={columns}
          data={conditionUnavailable ? [] : (confirmed?.rows ?? [])}
          rowCount={conditionUnavailable ? 0 : (confirmed?.total ?? 0)}
          pagination={pagination}
          onPaginationChange={setPagination}
          sorting={sortingState(order)}
          onSortingChange={(updater) =>
            reset(setOrder)(nextTableSort(updater, order))
          }
          getRowId={(row) => row.symbol}
          label="个股RPS排名"
          loading={page.isPending}
          error={page.error?.message}
          onRetry={() => void page.refetch()}
          showPagination={confirmed !== undefined && !conditionUnavailable}
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
