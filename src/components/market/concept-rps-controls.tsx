"use client";
import Link from "next/link";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { rpsPeriods } from "quant-rps";

import { useEffect, useRef, useState } from "react";
import {
  nextTableSort,
  sortingState,
  type TableSort,
} from "~/lib/common/server-sort";
import { api, type RouterOutputs } from "~/trpc/react";
import { rpsPeriodLabel } from "~/lib/screening/rps";
import {
  rpsConditionsLabel,
  type RpsCondition,
} from "~/lib/screening/rps-conditions";
import {
  defaultRpsTablePeriods,
  rpsSortColumnId,
} from "~/lib/market/market-pool";
import { SectorRpsConditionPopover } from "./industry-rps-controls";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { useAccumulatedPages, useTablePage } from "../ui/use-infinite-table";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { PoolMembersLink } from "./pool-members-link";
import { usePanelVisible } from "../workbench/keep-alive";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  FilterDivider,
  FilterGroup,
  FilterToolbar,
  MethodologyPopover,
} from "../panels";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Row = RouterOutputs["conceptRpsPage"]["rows"][number];
const rowKey = (row: Row) => row.name;

/** Primary and sorted periods stay visible so a ranking column cannot be hidden. */
function mergeRpsColumns(
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

const conceptRpsMethodology = [
  {
    label: "涨幅口径",
    detail:
      "概念涨幅取成分股后复权涨幅的等权平均；重叠成分在不同概念内分别计数，数值不等同于通达信概念指数。",
  },
  {
    label: "排名",
    detail: "RPS 为概念之间的横截面分位（0–100）；条件过滤不重新排名。",
  },
  {
    label: "证券范围",
    detail: "按当前板块成分计算，自动剔除 ST 和 *ST。",
  },
  {
    label: "保留",
    detail: "保留最近 750 个结果日。",
  },
];

function columns(
  period: number,
  displayedPeriods: readonly number[],
  sortedPeriod: number | undefined,
  conditions: RpsCondition[],
): DataTableColumn<Row>[] {
  return [
    {
      id: "name",
      enableSorting: true,
      header: "概念",
      cell: ({ row }) => (
        <PoolMembersLink category="concept" name={row.original.name} />
      ),
    },
    {
      id: "rank",
      enableSorting: true,
      header: `RPS${period} 排名`,
      cell: ({ row }) => row.original.value?.rank ?? "—",
    },
    ...displayedPeriods.map((p): DataTableColumn<Row> => ({
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
      header: `${period}日等权涨幅`,
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
          } satisfies DataTableColumn<Row>,
        ]
      : []),
  ];
}

/** Container owns requests; the DataTable consumes server-prepared props. */
export function ConceptRpsControls() {
  const [message, setMessage] = useState("");
  const [date, setDate] = useState("");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState(50);
  const [columnChoice, setColumnChoice] = useState<number[]>([
    ...defaultRpsTablePeriods,
  ]);
  const [conditions, setConditions] = useState<RpsCondition[]>([]);
  const [order, setOrder] = useState<TableSort>(null);
  const resetKey = JSON.stringify([date, search, period, conditions, order]);
  const cursor = useTablePage(resetKey);
  const visible = usePanelVisible();
  const status = api.conceptRpsStatus.useQuery(undefined, {
    enabled: visible,
    refetchInterval: 3000,
  });
  const page = api.conceptRpsPage.useQuery(
    {
      date: date || undefined,
      search,
      period,
      conditions,
      page: cursor.pageIndex,
      order,
    },
    {
      enabled: visible,
      staleTime: 0,
      refetchInterval:
        cursor.pageIndex === 0 && status.data?.progress?.status === "running"
          ? 5000
          : false,
    },
  );
  // Only the current key's successful response is evidence for the summary,
  // rows, bases and paging. A same-key background refresh keeps it; a key
  // change or a failed refresh never shows the previous batch as this one.
  const result =
    page.isSuccess && !page.isPlaceholderData ? page.data : undefined;
  const batches = useAccumulatedPages({
    resetKey,
    pageIndex: cursor.pageIndex,
    items: result?.rows,
    total: result?.total,
    metadata: result,
    getKey: rowKey,
  });
  const confirmed = page.isError ? undefined : batches.metadata;
  function refresh() {
    if (cursor.pageIndex === 0) void page.refetch();
    else cursor.restart();
  }
  const onError = (error: { message: string }) => setMessage(error.message);
  const onSuccess = () => {
    setMessage("请求已处理");
    void status.refetch();
    refresh();
  };
  const start = api.rpsStart.useMutation({ onSuccess, onError });
  const cancel = api.rpsCancel.useMutation({ onSuccess, onError });
  const running = status.data?.progress?.status === "running";
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) refresh();
    wasRunning.current = running;
  });
  const ready = status.data?.ready && status.data.tdxConfigured !== false;
  const busy =
    running || start.isPending || status.isPending || status.isError || !ready;
  const conditionUnavailable =
    conditions.length > 0 && confirmed
      ? confirmed.day === null ||
        (confirmed.conditions ?? []).some(
          (condition) => condition.periodMissing,
        )
      : false;
  const appliedText = rpsConditionsLabel(conditions);
  const missingConditionPeriods = (confirmed?.conditions ?? [])
    .filter((condition) => condition.periodMissing)
    .map((condition) => rpsPeriodLabel(condition.period))
    .join("、");
  const sortedPeriod = rpsPeriods.find((p) => order?.id === rpsSortColumnId(p));
  const displayedPeriods = mergeRpsColumns(columnChoice, period, sortedPeriod);
  const toggleRpsPeriod = (target: number) =>
    setColumnChoice(
      displayedPeriods.includes(target)
        ? displayedPeriods.filter((value) => value !== target)
        : [...displayedPeriods, target],
    );
  return (
    <section className="space-y-3" aria-label="概念RPS数据管理">
      {status.isSuccess && !ready && (
        <p className="text-sm text-muted-foreground">
          板块成分来源或通达信目录尚未就绪。{" "}
          <Link href="/system" className="underline">
            前往数据源设置配置
          </Link>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            start.mutate({ target: "concept", mode: "backfill", days: 250 })
          }
        >
          回填概念最近250日
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            start.mutate({ target: "concept", mode: "forward", days: 1 })
          }
        >
          计算今日概念
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!running || cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          取消任务
        </Button>
      </div>
      {message && <p role="status">{message}</p>}
      {status.isError && (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          读取失败：{status.error.message}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void status.refetch()}
          >
            重试
          </Button>
        </div>
      )}
      <FilterToolbar label="概念 RPS 筛选">
        <FilterGroup>
          <Select
            value={String(period)}
            onValueChange={(value) => {
              setPeriod(Number(value));
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="概念RPS周期"
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
                RPS列 · {displayedPeriods.length}
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
                      checked={displayedPeriods.includes(p)}
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
                  onClick={() => setColumnChoice([...defaultRpsTablePeriods])}
                >
                  默认
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  title="显示全部 RPS 周期"
                  onClick={() => setColumnChoice([...rpsPeriods])}
                >
                  全选
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </FilterGroup>
        <FilterGroup>
          <Input
            className="h-8 w-40"
            aria-label="搜索概念名称"
            placeholder="搜概念名称"
            maxLength={80}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </FilterGroup>
        <FilterGroup>
          <Input
            type="date"
            className="h-8 w-36"
            aria-label="结果日期"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </FilterGroup>
        <SectorRpsConditionPopover
          conditions={conditions}
          onChange={setConditions}
        />
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
          onClick={() => setOrder(null)}
        >
          重置排序
        </Button>
        <div className="ml-auto shrink-0">
          <MethodologyPopover
            title="概念 RPS 口径"
            items={conceptRpsMethodology}
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
              ? `命中 ${confirmed.total} 个概念`
              : "等待当前条件的成功查询结果"}
        </span>
        {confirmed?.day && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              RPS基准日：{confirmed.day.date} · 展示周期{" "}
              {rpsPeriodLabel(period)} 排名基数：
              {confirmed.day.count ?? "—"} ·{" "}
              {confirmed.day.mode === "backfill" ? "回填数据" : "向前数据"}
            </span>
          </>
        )}
        {confirmed?.conditions?.length ? (
          <span>
            条件周期有效排名基数：
            {confirmed.conditions
              .map(
                (condition) =>
                  `${rpsPeriodLabel(condition.period)} ${condition.count ?? "未计算"}`,
              )
              .join(" / ")}
          </span>
        ) : null}
        {page.isFetching && <span>正在刷新…</span>}
      </div>
      <DataTable
        columns={columns(period, displayedPeriods, sortedPeriod, conditions)}
        data={
          conditionUnavailable || (page.isError && cursor.pageIndex === 0)
            ? []
            : batches.rows
        }
        rowCount={conditionUnavailable ? undefined : confirmed?.total}
        sorting={sortingState(order)}
        onSortingChange={(updater) => {
          setOrder(nextTableSort(updater, order));
        }}
        getRowId={rowKey}
        label="概念RPS排名"
        loading={page.isFetching || page.isPending}
        error={page.error?.message}
        onRetry={() => void page.refetch()}
        infiniteScroll={{
          hasMore: !conditionUnavailable && batches.hasMore,
          loadingMore: cursor.pageIndex > 0 && page.isFetching,
          onLoadMore: cursor.loadMore,
        }}
        emptyMessage={
          !confirmed
            ? "等待当前条件的成功查询结果。"
            : conditionUnavailable
              ? confirmed.day === null
                ? "所选日期没有概念批次，条件未执行；这不表示筛选结果为 0。"
                : `当前批次未计算 ${missingConditionPeriods}，条件未执行；这不表示筛选结果为 0。`
              : conditions.length
                ? "没有同时满足全部条件的概念。可放宽阈值、改选周期，或确认当前批次是否计算了这些周期。"
                : "该日尚无概念排名，请核对数据后计算。"
        }
      />
    </section>
  );
}
