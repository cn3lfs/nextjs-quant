"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import type { SortingState } from "@tanstack/react-table";
import { formatNumber } from "trading-strategy-core/format-number";
import {
  ArrowLineUp,
  ArrowsClockwise,
  Check,
  PencilSimple,
  Plus,
  Star,
  Trash,
  X,
} from "@phosphor-icons/react/ssr";
import { api } from "~/trpc/react";
import { cn } from "~/lib/common/classnames";
import { securityDisplayName } from "~/lib/market/security-display";
import { Button } from "../ui/button";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { Input } from "../ui/input";
import { useInfiniteSlice } from "../ui/use-infinite-table";
import { Segmented } from "../panels";
import { useQuoteRefreshInterval } from "./use-quote-session";
import { useSecurityNames } from "./use-security-names";
import { BrowseSource, useOpenChart } from "./open-chart";
import { useTaskVisible } from "../workbench/use-task-visible";
import { useWorkbenchNotify } from "../workbench/workbench-notify";

type WatchlistSort = "saved" | "gain" | "loss" | "amount";

type WatchlistRow = {
  symbol: string;
  name: string;
  price: number | null;
  preClose: number | null;
  change: number | null;
  changePct: number | null;
  amount: number | null;
  savedIndex: number;
};

const A_SHARE_CODE = /^(sh|sz|bj)\d{6}$/;

function normalizeDirectSymbol(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase();
  if (A_SHARE_CODE.test(cleaned)) return cleaned;
  if (/^\d{6}$/.test(cleaned)) {
    if (cleaned.startsWith("6") || cleaned.startsWith("9"))
      return `sh${cleaned}`;
    if (
      cleaned.startsWith("0") ||
      cleaned.startsWith("2") ||
      cleaned.startsWith("3")
    )
      return `sz${cleaned}`;
  }
  return null;
}

function formatClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function toneOf(changePct: number | null) {
  if (changePct === null || changePct === 0) return "text-nc-text-3";
  return changePct > 0 ? "text-nc-up" : "text-nc-down";
}

function signed(value: number, suffix = "") {
  return `${value > 0 ? "+" : ""}${formatNumber(value, 2)}${suffix}`;
}

/**
 * 独立「我的自选」工作页：面向大量自选股的实时监控、快速搜索添加、
 * 过滤排序、置顶/移出与点击跳转看盘（支持 PgUp/PgDn 连续翻股）。
 */
export function WatchlistView() {
  const visible = useTaskVisible();
  const notify = useWorkbenchNotify();
  const interval = useQuoteRefreshInterval();
  const utils = api.useUtils();
  const [sort, setSort] = useState<WatchlistSort>("saved");
  const [filterText, setFilterText] = useState("");
  const [addQuery, setAddQuery] = useState("");
  const [activeGroupId, setActiveGroupId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const groupsQuery = api.watchlistGroups.useQuery(undefined, {
    enabled: visible,
    staleTime: 30_000,
  });
  const groups = useMemo(
    () => groupsQuery.data?.groups ?? [],
    [groupsQuery.data],
  );
  const activeGroup = useMemo(
    () =>
      groups.find((g) => g.id === activeGroupId) ??
      groups.find((g) => g.id === groupsQuery.data?.defaultGroupId) ??
      groups[0] ??
      null,
    [groups, activeGroupId, groupsQuery.data?.defaultGroupId],
  );
  const watchlist = useMemo(() => activeGroup?.symbols ?? [], [activeGroup]);
  const names = useSecurityNames().data ?? {};

  const quotes = api.overviewQuotes.useQuery(watchlist, {
    enabled: visible && watchlist.length > 0,
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: visible && watchlist.length > 0 ? interval : false,
  });

  const trimmedAdd = addQuery.trim();
  const searchResults = api.quickSearchSecurities.useQuery(
    { query: trimmedAdd, limit: 10 },
    {
      enabled: visible && trimmedAdd.length >= 1,
      staleTime: 30_000,
    },
  );

  const invalidateGroups = () => {
    void utils.watchlistGroups.invalidate();
    void utils.status.invalidate();
  };

  const createGroup = api.watchlistGroupCreate.useMutation({
    onSuccess: (result) => {
      invalidateGroups();
      setActiveGroupId(result.group.id);
      setCreating(false);
      setCreateName("");
      notify(`已新建自选列表「${result.group.name}」`);
    },
    onError: (error) => notify(error.message),
  });

  const renameGroup = api.watchlistGroupRename.useMutation({
    onSuccess: (result) => {
      invalidateGroups();
      setRenaming(false);
      notify(`已重命名为「${result.group.name}」`);
    },
    onError: (error) => notify(error.message),
  });

  const deleteGroup = api.watchlistGroupDelete.useMutation({
    onSuccess: (result) => {
      invalidateGroups();
      setActiveGroupId(result.defaultGroupId);
      setConfirmDelete(false);
      notify("已删除自选列表");
    },
    onError: (error) => notify(error.message),
  });

  const addSymbolsMut = api.watchlistGroupAddSymbols.useMutation({
    onSuccess: () => invalidateGroups(),
    onError: (error) => notify(error.message),
  });

  const removeSymbolMut = api.watchlistGroupRemoveSymbol.useMutation({
    onSuccess: () => invalidateGroups(),
    onError: (error) => notify(error.message),
  });

  const setSymbolsMut = api.watchlistGroupSetSymbols.useMutation({
    onSuccess: () => invalidateGroups(),
    onError: (error) => notify(error.message),
  });

  const pinSymbolMut = api.watchlistGroupPinSymbol.useMutation({
    onSuccess: () => invalidateGroups(),
    onError: (error) => notify(error.message),
  });

  const mutating =
    addSymbolsMut.isPending ||
    removeSymbolMut.isPending ||
    setSymbolsMut.isPending ||
    pinSymbolMut.isPending ||
    createGroup.isPending ||
    renameGroup.isPending ||
    deleteGroup.isPending;

  const quoteBySymbol = useMemo(
    () => new Map((quotes.data?.quotes ?? []).map((q) => [q.symbol, q])),
    [quotes.data],
  );

  const addSymbol = (symbol: string) => {
    if (!activeGroup) return;
    const normalized = symbol.trim().toLowerCase();
    if (!A_SHARE_CODE.test(normalized)) {
      notify("仅支持沪深 A 股/指数代码（如 sh600519、sz300750）");
      return;
    }
    if (watchlist.includes(normalized)) {
      notify(
        `${securityDisplayName(normalized, names)} 已在「${activeGroup.name}」中`,
      );
      return;
    }
    // A mutate-level callback replaces the hook-level one in tRPC, so the
    // invalidation has to run here as well or the list never refreshes.
    addSymbolsMut.mutate(
      { groupId: activeGroup.id, symbols: [normalized] },
      {
        onSuccess: () => {
          invalidateGroups();
          setAddQuery("");
          notify(
            `已加入「${activeGroup.name}」：${securityDisplayName(normalized, names)}`,
          );
        },
      },
    );
  };

  const removeSymbol = (symbol: string) => {
    if (!activeGroup) return;
    removeSymbolMut.mutate(
      { groupId: activeGroup.id, symbol },
      {
        onSuccess: () => {
          invalidateGroups();
          notify(
            `已从「${activeGroup.name}」移出：${securityDisplayName(symbol, names)}`,
          );
        },
      },
    );
  };

  const pinToTop = (symbol: string) => {
    if (!activeGroup) return;
    pinSymbolMut.mutate({
      groupId: activeGroup.id,
      symbol,
    });
  };

  const rows = useMemo<WatchlistRow[]>(() => {
    const needle = filterText.trim().toLowerCase();
    const mapped = watchlist
      .map((symbol, savedIndex) => {
        const displayName = securityDisplayName(symbol, names);
        const q = quoteBySymbol.get(symbol);
        const price = q && q.price > 0 ? q.price : null;
        const preClose = q && q.preClose > 0 ? q.preClose : null;
        const change =
          price !== null && preClose !== null ? price - preClose : null;
        const changePct =
          price !== null && preClose !== null
            ? (price / preClose - 1) * 100
            : null;
        const amount = q && q.amount > 0 ? q.amount : null;
        return {
          symbol,
          name: displayName,
          price,
          preClose,
          change,
          changePct,
          amount,
          savedIndex,
        };
      })
      .filter(
        (row) =>
          !needle ||
          row.symbol.toLowerCase().includes(needle) ||
          row.name.toLowerCase().includes(needle),
      );

    if (sort === "saved") return mapped;
    return [...mapped].sort((a, b) => {
      const av = sort === "amount" ? a.amount : a.changePct;
      const bv = sort === "amount" ? b.amount : b.changePct;
      if (av === null || bv === null) {
        if (av === bv) return a.savedIndex - b.savedIndex;
        return av === null ? 1 : -1;
      }
      const delta = sort === "loss" ? av - bv : bv - av;
      return delta !== 0 ? delta : a.savedIndex - b.savedIndex;
    });
  }, [watchlist, names, quoteBySymbol, filterText, sort]);

  const orderedSymbols = useMemo(() => rows.map((r) => r.symbol), [rows]);
  const summary = useMemo(() => {
    let up = 0;
    let down = 0;
    let flat = 0;
    for (const row of rows) {
      if (row.changePct === null) continue;
      if (row.changePct > 0) up += 1;
      else if (row.changePct < 0) down += 1;
      else flat += 1;
    }
    return { up, down, flat };
  }, [rows]);

  const slice = useInfiniteSlice(
    rows,
    40,
    `${activeGroup?.id ?? ""}:${sort}:${filterText.trim()}`,
  );
  const candidates = (searchResults.data?.items ?? []).filter((item) =>
    A_SHARE_CODE.test(item.symbol),
  );
  const directSymbol = normalizeDirectSymbol(trimmedAdd);

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-lg border border-nc-border bg-nc-card p-4">
        <div
          role="tablist"
          aria-label="自选列表标签栏"
          className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-nc-border-soft pb-3"
        >
          {groups.map((group) => {
            const active = activeGroup?.id === group.id;
            return (
              <Button
                key={group.id}
                type="button"
                role="tab"
                aria-selected={active}
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => {
                  setActiveGroupId(group.id);
                  setRenaming(false);
                  setConfirmDelete(false);
                }}
              >
                {group.name} ({group.symbols.length})
              </Button>
            );
          })}
          {creating ? (
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const name = createName.trim();
                if (!name) return;
                createGroup.mutate({ name });
              }}
            >
              <Input
                aria-label="新自选列表名称"
                placeholder="列表名称"
                className="h-8 w-36"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                autoFocus
              />
              <Button
                type="submit"
                size="sm"
                disabled={!createName.trim() || createGroup.isPending}
              >
                <Check size={13} />
                创建
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setCreateName("");
                }}
              >
                <X size={13} />
              </Button>
            </form>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreating(true);
                setRenaming(false);
                setConfirmDelete(false);
              }}
            >
              <Plus size={13} />
              新建列表
            </Button>
          )}
          {activeGroup && (
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {renaming ? (
                <form
                  className="inline-flex items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = renameName.trim();
                    if (!name) return;
                    renameGroup.mutate({ groupId: activeGroup.id, name });
                  }}
                >
                  <Input
                    aria-label="重命名自选列表"
                    className="h-8 w-36"
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    autoFocus
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!renameName.trim() || renameGroup.isPending}
                  >
                    保存
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setRenaming(false)}
                  >
                    取消
                  </Button>
                </form>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setRenameName(activeGroup.name);
                    setRenaming(true);
                    setCreating(false);
                    setConfirmDelete(false);
                  }}
                >
                  <PencilSimple size={13} />
                  重命名
                </Button>
              )}
              {confirmDelete ? (
                <span className="inline-flex items-center gap-1 text-xs">
                  <span className="text-nc-warn">确认删除？</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="danger"
                    disabled={deleteGroup.isPending}
                    onClick={() =>
                      deleteGroup.mutate({ groupId: activeGroup.id })
                    }
                  >
                    确认
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(false)}
                  >
                    取消
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={groups.length <= 1 || deleteGroup.isPending}
                  title={
                    groups.length <= 1 ? "至少保留一个自选列表" : "删除当前列表"
                  }
                  onClick={() => {
                    setConfirmDelete(true);
                    setRenaming(false);
                  }}
                >
                  <Trash size={13} />
                  删除列表
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Star size={18} weight="fill" className="text-nc-warn" />
            <h2 className="m-0 text-[16px] font-semibold text-nc-text">
              {activeGroup?.name ?? "我的自选"}
            </h2>
            <span className="rounded bg-nc-surface-2 px-2 py-0.5 text-xs tabular-nums text-nc-text-3">
              共 {watchlist.length} 只
            </span>
          </div>
          {watchlist.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-[13px] tabular-nums">
              <span className="text-nc-up">涨 {summary.up}</span>
              <span className="text-nc-text-3">平 {summary.flat}</span>
              <span className="text-nc-down">跌 {summary.down}</span>
            </div>
          )}
          <span className="text-xs text-nc-text-4">
            {quotes.error
              ? `实时行情读取失败：${quotes.error.message}`
              : quotes.data?.fetchedAt
                ? `${quotes.data.source} · 更新于 ${formatClock(quotes.data.fetchedAt)}`
                : watchlist.length > 0
                  ? "正在获取实时行情…"
                  : "搜索添加自选后显示实时行情"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={quotes.isFetching || watchlist.length === 0}
              onClick={() => void quotes.refetch()}
            >
              <ArrowsClockwise size={14} />
              刷新实时
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1 max-w-md">
            <Input
              aria-label="搜索并添加自选证券"
              placeholder="输入代码、名称或拼音添加自选（如 600519 / 茅台）"
              value={addQuery}
              onChange={(event) => setAddQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (candidates[0]) addSymbol(candidates[0].symbol);
                else if (directSymbol) addSymbol(directSymbol);
              }}
            />
            {trimmedAdd.length > 0 && (
              <div
                role="listbox"
                aria-label="添加自选候选"
                className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-auto rounded-md border border-nc-border bg-nc-card shadow-lg"
              >
                {searchResults.isLoading ? (
                  <p className="m-0 px-3 py-2 text-xs text-nc-text-3">
                    正在搜索证券…
                  </p>
                ) : candidates.length > 0 ? (
                  candidates.map((item) => {
                    const exists = watchlist.includes(item.symbol);
                    return (
                      <button
                        key={item.symbol}
                        type="button"
                        disabled={exists || mutating}
                        onClick={() => addSymbol(item.symbol)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-nc-surface-2 disabled:cursor-default disabled:opacity-60"
                      >
                        <span className="truncate font-medium text-nc-text">
                          {item.name}
                          <span className="ml-2 font-normal text-nc-text-4">
                            {item.symbol.toUpperCase()}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-nc-accent">
                          {exists ? "已在自选" : "+ 加入自选"}
                        </span>
                      </button>
                    );
                  })
                ) : directSymbol ? (
                  <button
                    type="button"
                    disabled={watchlist.includes(directSymbol) || mutating}
                    onClick={() => addSymbol(directSymbol)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-[13px] hover:bg-nc-surface-2"
                  >
                    <span>直接加入 {directSymbol.toUpperCase()}</span>
                    <Plus size={14} />
                  </button>
                ) : (
                  <p className="m-0 px-3 py-2 text-xs text-nc-text-4">
                    未找到匹配的 A 股证券，可输入完整 6 位代码（如 sh600519）
                  </p>
                )}
              </div>
            )}
          </div>

          <Input
            aria-label="在我的自选中筛选"
            placeholder="筛选已加自选…"
            className="w-44"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
          />

          <Segmented
            label="自选排序"
            value={sort}
            onChange={setSort}
            options={[
              { value: "saved", label: "保存顺序" },
              { value: "gain", label: "涨幅优先" },
              { value: "loss", label: "跌幅优先" },
              { value: "amount", label: "成交额优先" },
            ]}
          />
        </div>
      </section>

      {groupsQuery.error ? (
        <div
          role="alert"
          className="rounded-lg border border-nc-bad/40 bg-nc-card p-4 text-sm text-nc-bad"
        >
          自选列表读取失败：{groupsQuery.error.message}
        </div>
      ) : (
        <BrowseSource
          label={activeGroup?.name ?? "我的自选"}
          symbols={orderedSymbols}
        >
          <WatchlistTable
            rows={slice.rows}
            total={rows.length}
            hasMore={slice.hasMore}
            onLoadMore={slice.onLoadMore}
            sort={sort}
            pending={mutating}
            onPin={pinToTop}
            onRemove={removeSymbol}
          />
        </BrowseSource>
      )}
    </div>
  );
}

function WatchlistTable({
  rows,
  total,
  hasMore,
  onLoadMore,
  sort,
  pending,
  onPin,
  onRemove,
}: {
  rows: readonly WatchlistRow[];
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
  sort: WatchlistSort;
  pending: boolean;
  onPin: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const openChart = useOpenChart();
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<DataTableColumn<WatchlistRow>[]>(
    () => [
      {
        id: "security",
        header: "证券",
        cell: ({ row }) => {
          const item = row.original;
          const href = `/scan?symbol=${encodeURIComponent(item.symbol)}`;
          return (
            <Link
              href={href}
              scroll={false}
              onClick={(event) => {
                if (!openChart) return;
                event.preventDefault();
                openChart(item.symbol);
              }}
              className="inline-flex flex-col text-left hover:underline"
            >
              <span className="font-medium text-nc-text">{item.name}</span>
              <span className="text-xs tabular-nums text-nc-text-4">
                {item.symbol.toUpperCase()}
              </span>
            </Link>
          );
        },
      },
      {
        id: "price",
        header: "现价",
        meta: { align: "right" as const },
        cell: ({ row }) => (
          <span
            className={cn(
              "font-medium tabular-nums",
              toneOf(row.original.changePct),
            )}
          >
            {row.original.price === null
              ? "—"
              : formatNumber(row.original.price, 2)}
          </span>
        ),
      },
      {
        id: "changePct",
        header: "涨跌幅",
        meta: { align: "right" as const },
        cell: ({ row }) => (
          <span
            className={cn(
              "font-medium tabular-nums",
              toneOf(row.original.changePct),
            )}
          >
            {row.original.changePct === null
              ? "—"
              : signed(row.original.changePct, "%")}
          </span>
        ),
      },
      {
        id: "change",
        header: "涨跌额",
        meta: { align: "right" as const },
        cell: ({ row }) => (
          <span className={cn("tabular-nums", toneOf(row.original.changePct))}>
            {row.original.change === null ? "—" : signed(row.original.change)}
          </span>
        ),
      },
      {
        id: "preClose",
        header: "昨收",
        meta: { align: "right" as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-nc-text-3">
            {row.original.preClose === null
              ? "—"
              : formatNumber(row.original.preClose, 2)}
          </span>
        ),
      },
      {
        id: "amount",
        header: "成交额",
        meta: { align: "right" as const },
        cell: ({ row }) => (
          <span className="tabular-nums text-nc-text-3">
            {row.original.amount === null
              ? "—"
              : `${formatNumber(row.original.amount / 1e8, 2)} 亿`}
          </span>
        ),
      },
      {
        id: "actions",
        header: "操作",
        meta: { align: "right" as const },
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="inline-flex items-center justify-end gap-1">
              {sort === "saved" && item.savedIndex > 0 && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  title="置顶到自选首位"
                  aria-label={`置顶 ${item.name}`}
                  onClick={() => onPin(item.symbol)}
                >
                  <ArrowLineUp size={14} />
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                title="移出自选"
                aria-label={`移出 ${item.name}`}
                onClick={() => onRemove(item.symbol)}
              >
                <Trash size={14} />
              </Button>
            </div>
          );
        },
      },
    ],
    [openChart, sort, pending, onPin, onRemove],
  );

  return (
    <DataTable
      label="我的自选列表"
      data={rows as WatchlistRow[]}
      rowCount={total}
      columns={columns}
      sorting={sorting}
      onSortingChange={setSorting}
      getRowId={(row) => row.symbol}
      emptyMessage="暂无自选标的，可在上方搜索添加或在 A 股看盘页一键加入自选。"
      infiniteScroll={{
        hasMore,
        onLoadMore,
      }}
    />
  );
}
