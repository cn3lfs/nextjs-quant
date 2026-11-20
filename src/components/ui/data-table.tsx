"use client";

import {
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type OnChangeFn,
  type PaginationState,
  type SortingState,
} from "@tanstack/react-table";
import { useIntersectionLoadMore } from "./use-infinite-table";
import { Button } from "~/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useId, useMemo, type ReactNode } from "react";

// State coordination only: no sorted/paginated row-model plugins are registered.
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
});
export type DataTableColumn<T extends object> = ColumnDef<
  typeof dataTableFeatures,
  T
>;
export type DataTableProps<T extends object> = {
  columns: DataTableColumn<T>[];
  /** One page or the accumulated batches in display order. */
  data: T[];
  rowCount: number;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  getRowId: (row: T) => string;
  label: string;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  emptyMessage?: ReactNode;
  /** Existing page toolbars keep ownership of pagination during R2 migration. */
  showPagination?: boolean;
  pagination: PaginationState;
  onPaginationChange: OnChangeFn<PaginationState>;
  infiniteScroll?: {
    hasMore: boolean;
    loadingMore?: boolean;
    onLoadMore: () => void;
    /** Viewport margin for observing the bottom sentinel. */
    rootMargin?: string;
    /** Rows before the first batch when restoring a paged deep link. */
    startOffset?: number;
  };
};

type InfiniteDataTableProps<T extends object> = Omit<
  DataTableProps<T>,
  "pagination" | "onPaginationChange" | "infiniteScroll" | "rowCount"
> & {
  /** Unavailable ranking conditions have no meaningful total. */
  rowCount: number | undefined;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  infiniteScroll: NonNullable<DataTableProps<T>["infiniteScroll"]>;
};

const firstPage = { pageIndex: 0, pageSize: 20 };

/** TanStack only sorts columns with an accessor. Display columns that opt in
 *  with `enableSorting: true` are ordered by the server (manualSorting), so a
 *  placeholder accessor is enough to expose their sort button. */
function serverSortable<T extends object>(
  column: DataTableColumn<T>,
): DataTableColumn<T> {
  const c = column as DataTableColumn<T> & {
    accessorKey?: unknown;
    accessorFn?: unknown;
  };
  return c.enableSorting === true && !c.accessorKey && !c.accessorFn
    ? ({ ...column, accessorFn: () => null } as DataTableColumn<T>)
    : column;
}

export function DataTable<T extends object>({
  columns,
  data,
  rowCount,
  pagination = firstPage,
  sorting,
  onPaginationChange,
  onSortingChange,
  getRowId,
  label,
  loading = false,
  error,
  onRetry,
  emptyMessage = "暂无数据。",
  showPagination = true,
  infiniteScroll,
}: DataTableProps<T> | InfiniteDataTableProps<T>) {
  const sortHelpId = useId();
  const serverColumns = useMemo(() => columns.map(serverSortable), [columns]);
  const table = useTable({
    features: dataTableFeatures,
    columns: serverColumns,
    data,
    rowCount,
    getRowId,
    manualSorting: true,
    manualPagination: true,
    autoResetPageIndex: false,
    state: { pagination, sorting },
    onPaginationChange,
    onSortingChange,
  });
  const busy = loading || !!error;
  const sentinel = useIntersectionLoadMore({
    enabled: !!infiniteScroll?.hasMore,
    loading: busy || !!infiniteScroll?.loadingMore,
    onLoadMore: () => infiniteScroll?.onLoadMore(),
    rootMargin: infiniteScroll?.rootMargin,
  });
  const showBusyRow = busy && (!infiniteScroll || data.length === 0);
  const sortable = table
    .getAllLeafColumns()
    .some((column) => column.getCanSort());
  return (
    <section
      aria-label={label}
      aria-busy={loading || !!infiniteScroll?.loadingMore}
      className="space-y-3"
    >
      <div className="rounded-lg border border-border">
        {sortable && (
          <p id={sortHelpId} className="sr-only">
            列标题中的按钮可排序，按 Enter 或空格切换排序方向。
          </p>
        )}
        <Table
          aria-label={label}
          aria-describedby={sortable ? sortHelpId : undefined}
        >
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    colSpan={header.colSpan}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : undefined
                    }
                  >
                    {header.isPlaceholder ? null : header.column.getCanSort() ? (
                      <Button
                        variant="plain"
                        type="button"
                        data-slot="data-table-sort"
                        disabled={busy}
                        className="inline-flex items-center gap-2"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <table.FlexRender header={header} />
                        <span aria-hidden="true">
                          {header.column.getIsSorted() === "asc"
                            ? "↑"
                            : header.column.getIsSorted() === "desc"
                              ? "↓"
                              : "↕"}
                        </span>
                      </Button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {!busy &&
            !data.length &&
            emptyMessage === null ? null : showBusyRow || !data.length ? (
              <TableRow>
                <TableCell
                  colSpan={table.getAllLeafColumns().length || 1}
                  className="h-24 text-center"
                >
                  <span role={error ? "alert" : "status"}>
                    {error || (loading ? "正在加载…" : emptyMessage)}
                  </span>
                  {error && onRetry && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onRetry}
                    >
                      重试
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {infiniteScroll && (
        <>
          <div ref={sentinel} aria-hidden="true" className="h-px" />
          {error && data.length > 0 && (
            <div role="alert">
              {error}{" "}
              {onRetry && (
                <Button size="sm" variant="outline" onClick={onRetry}>
                  重试
                </Button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            {rowCount !== undefined && (
              <span
                className="text-sm text-muted-foreground"
                aria-live="polite"
              >
                {!infiniteScroll.hasMore &&
                data.length > 0 &&
                !infiniteScroll.startOffset
                  ? `已全部加载 · 共 ${rowCount} 条`
                  : `已加载 ${data.length} / 共 ${rowCount} 条`}
                {infiniteScroll.startOffset
                  ? ` · 从第 ${infiniteScroll.startOffset + 1} 条起`
                  : ""}
              </span>
            )}
            {infiniteScroll.hasMore && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || infiniteScroll.loadingMore}
                onClick={infiniteScroll.onLoadMore}
              >
                {infiniteScroll.loadingMore ? "加载中…" : "加载更多"}
              </Button>
            )}
          </div>
        </>
      )}
      {!infiniteScroll && showPagination && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted-foreground" aria-live="polite">
            共 {rowCount} 条 · 第 {rowCount ? pagination.pageIndex + 1 : 0} /{" "}
            {table.getPageCount()} 页
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              下一页
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
