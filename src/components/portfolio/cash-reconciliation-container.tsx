"use client";
import { useEffect, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  nextTableSort,
  sortingState,
  type TableSort,
} from "~/lib/common/server-sort";
import type { PaginationState } from "@tanstack/react-table";
import { api, type RouterOutputs } from "~/trpc/react";
import { cashWorkspacePageSchema } from "~/lib/portfolio/cash-workspace";
import type { CashReconciliationStatus } from "~/lib/portfolio/cash-reconciliation";
import { Button } from "../ui/button";
import { DataTable, type DataTableColumn } from "../ui/data-table";
import { useTaskVisible } from "../workbench/use-task-visible";
import { DeliveryField, DeliverySelect } from "./delivery-workspace-fields";
import { TradeError } from "./trade-workspace-fields";
import { cashReconciliationLabels } from "./cash-reconciliation-results";
import {
  CashWorkspaceDetail,
  type CashSelection,
} from "./cash-workspace-detail";
import { cashMoney, cashReadOptions } from "./cash-workspace-fields";

type Day = RouterOutputs["cashWorkspace"]["rows"][number];
type Filter = {
  start?: string;
  end?: string;
  status: "all" | CashReconciliationStatus;
};
export function CashReconciliationContainer({
  account,
  onBatch,
}: {
  account: string;
  onBatch: (id: string) => void;
}) {
  const utils = api.useUtils(),
    visible = useTaskVisible();
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  const [order, setOrder] = useState<TableSort>(null);
  const [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [status, setStatus] = useState<Filter["status"]>("all");
  const [filter, setFilter] = useState<Filter>({ status: "all" });
  const [selection, setSelection] = useState<CashSelection | null>(null);
  const [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState("");
  const [message, setMessage] = useState(""),
    [filterError, setFilterError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef({ id: "", scroll: 0 });
  const mounted = useRef(true),
    exportLock = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const query = api.cashWorkspace.useQuery(
    { account, ...pagination, ...filter, order },
    { ...cashReadOptions, enabled: visible, placeholderData: keepPreviousData },
  );
  const data = query.data;
  useEffect(() => {
    if (data && !query.isFetching && data.pageIndex !== pagination.pageIndex)
      setPagination((current) => ({ ...current, pageIndex: data.pageIndex }));
  }, [data, query.isFetching, pagination.pageIndex]);
  const stale = !!selection && !!data && selection.version !== data.version;
  const open = (next: CashSelection) => {
    returnTo.current = {
      id: document.activeElement?.id ?? "",
      scroll: window.scrollY,
    };
    setSelection(next);
  };
  const close = () => {
    setSelection(null);
    requestAnimationFrame(() => {
      const trigger = document.getElementById(returnTo.current.id);
      (trigger ?? heading.current)?.focus({ preventScroll: true });
      window.scrollTo({ top: returnTo.current.scroll });
      if (!trigger)
        setMessage("原日期不在当前页，已返回日期列表。筛选和排序已保留。");
    });
  };
  const apply = () => {
    const next = { start: start || undefined, end: end || undefined, status };
    const parsed = cashWorkspacePageSchema.safeParse(next);
    if (!parsed.success) {
      setFilterError(parsed.error.issues[0]?.message ?? "日期范围无效");
      return;
    }
    setFilter(next);
    setPagination((p) => ({ ...p, pageIndex: 0 }));
    setFilterError("");
    setSelection(null);
  };
  const refresh = async () => {
    const refreshed = await query.refetch();
    if (refreshed.data && !refreshed.error && mounted.current) {
      setPagination((p) => ({ ...p, pageIndex: refreshed.data.pageIndex }));
      setSelection((current) =>
        current ? { ...current, version: refreshed.data.version } : null,
      );
      setMessage("现金核对已刷新，筛选和排序已保留。");
    }
  };
  const download = async () => {
    if (!data || exportLock.current) return;
    exportLock.current = true;
    setExporting(true);
    setExportError("");
    setMessage("");
    const identity = { account, version: data.version };
    try {
      const result = await utils.cashWorkspaceExport.fetch(identity, {
        staleTime: 0,
        gcTime: 0,
      });
      if (!mounted.current) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      try {
        link.href = url;
        link.download = `现金核对证据-${account}.json`;
        document.body.appendChild(link);
        link.click();
        setMessage(
          `已触发账户「${account}」全部日期证据下载，不限筛选或当前页。`,
        );
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      if (mounted.current)
        setExportError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      exportLock.current = false;
      if (mounted.current) setExporting(false);
    }
  };
  const columns: DataTableColumn<Day>[] = [
    {
      accessorKey: "date",
      header: "日期",
      cell: ({ row }) => (
        <Button
          id={`cash-date-${row.original.date}`}
          size="sm"
          variant="ghost"
          onClick={() =>
            data &&
            open({
              kind: "date",
              date: row.original.date,
              version: data.version,
            })
          }
        >
          {row.original.date}
        </Button>
      ),
    },
    {
      accessorKey: "status",
      header: "状态",
      cell: ({ row }) => cashReconciliationLabels[row.original.status],
    },
    {
      accessorKey: "statementCash",
      header: "柜台（元）",
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {cashMoney(row.original.statementCash)}
        </span>
      ),
    },
    {
      accessorKey: "projectedCash",
      header: "推算（元）",
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {cashMoney(row.original.projectedCash)}
        </span>
      ),
    },
    {
      accessorKey: "difference",
      header: "差额（柜台 − 推算）",
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {cashMoney(row.original.difference, true)}
        </span>
      ),
    },
    {
      id: "evidence",
      header: "来源",
      enableSorting: true,
      cell: ({ row }) => row.original.sourceCount,
    },
  ];
  return (
    <section aria-label="现金核对" className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold">
          现金核对 · {account}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={query.isFetching}
          >
            刷新现金核对
          </Button>
          <Button
            variant="outline"
            disabled={exporting || !data || !!query.error}
            onClick={() => void download()}
          >
            {exporting ? "正在导出…" : "导出全部日期证据"}
          </Button>
        </div>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <TradeError error={exportError} onRetry={() => void download()} />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <DeliveryField
          label="现金起始日期"
          type="date"
          value={start}
          onChange={setStart}
        />
        <DeliveryField
          label="现金结束日期"
          type="date"
          value={end}
          onChange={setEnd}
        />
        <div className="w-40">
          <DeliverySelect
            label="现金核对状态筛选"
            value={status}
            onChange={(value) => setStatus(value as Filter["status"])}
            options={{ all: "全部状态", ...cashReconciliationLabels }}
          />
        </div>
        <Button type="submit">查询现金日期</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setStart("");
            setEnd("");
            setStatus("all");
            setFilter({ status: "all" });
            setOrder(null);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
            setSelection(null);
            setFilterError("");
          }}
        >
          重置现金筛选
        </Button>
      </form>
      <TradeError error={filterError} />
      <p role="status" className="min-h-5 text-sm">
        {query.isFetching
          ? data
            ? "正在核对现金…下方保留上次读取结果，完成后更新。"
            : "正在核对现金…"
          : ""}
      </p>
      <TradeError error={query.error?.message} onRetry={() => void refresh()} />
      {data && !query.error && (
        <>
          <div
            className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 xl:grid-cols-6"
            aria-label="全账户现金汇总"
          >
            {(
              [
                ["核对日期", data.summary.days],
                ["可比较", data.summary.comparableDays],
                ["日末相等", data.summary.matchedDays],
                ["存在差异", data.summary.differenceDays],
                ["待核对", data.summary.unavailableDays],
                ["来源冲突", data.summary.conflictDays],
              ] as const
            ).map(([label, count]) => (
              <div key={label} className="rounded border border-border p-3">
                <p className="text-muted-foreground">{label}</p>
                <p className="mt-1 text-xl tabular-nums">
                  {count} <span className="text-xs">天</span>
                </p>
              </div>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            全账户证据覆盖 {data.summary.evidenceStart ?? "未知"} 至{" "}
            {data.summary.evidenceEnd ?? "未知"}。当前筛选匹配 {data.total}{" "}
            天；全账户汇总不随筛选变化。日末现金相等不代表流水完整。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              id="cash-first-difference"
              variant="outline"
              disabled={!data.summary.firstDifferenceDate}
              onClick={() =>
                data.summary.firstDifferenceDate &&
                open({
                  kind: "date",
                  date: data.summary.firstDifferenceDate,
                  version: data.version,
                })
              }
            >
              首次差异 {data.summary.firstDifferenceDate ?? "无已确认差异"}
            </Button>
            <Button
              id="cash-opening"
              variant="outline"
              onClick={() => open({ kind: "opening", version: data.version })}
            >
              期初依据 · {data.opening.count}
            </Button>
            <Button
              id="cash-diagnostics"
              variant="outline"
              onClick={() =>
                open({ kind: "diagnostics", version: data.version })
              }
            >
              导入证据待核对 · {data.diagnosticCount}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{data.basis}</p>
          <div
            className={
              selection ? "grid min-w-0 gap-4 xl:grid-cols-2" : "min-w-0"
            }
          >
            <div className={selection ? "hidden min-w-0 xl:block" : "min-w-0"}>
              <fieldset
                disabled={query.isFetching}
                aria-busy={query.isFetching}
                className="min-w-0"
              >
                <legend className="sr-only">现金日期列表</legend>
                <DataTable
                  columns={columns}
                  data={data.rows}
                  rowCount={data.total}
                  pagination={{ ...pagination, pageIndex: data.pageIndex }}
                  onPaginationChange={setPagination}
                  sorting={sortingState(order)}
                  onSortingChange={(updater) => {
                    setOrder(nextTableSort(updater, order));
                    setPagination((p) => ({ ...p, pageIndex: 0 }));
                  }}
                  loading={false}
                  getRowId={(row) => row.date}
                  label="逐日现金核对"
                  emptyMessage="当前筛选下没有现金核对记录，可重置日期与状态。"
                />
              </fieldset>
            </div>
            {selection &&
              (stale ? (
                <div
                  role="alert"
                  className="space-y-3 rounded border border-border p-4"
                >
                  <p>
                    账户数据已更新，原详情版本已过期。筛选和日期选择已保留。
                  </p>
                  <Button onClick={() => void refresh()}>更新当前详情</Button>
                  <Button variant="outline" onClick={close}>
                    返回日期列表
                  </Button>
                </div>
              ) : (
                <CashWorkspaceDetail
                  key={JSON.stringify(selection)}
                  account={account}
                  selection={selection}
                  active={visible}
                  onBack={close}
                  onBatch={onBatch}
                  onRefresh={() => void refresh()}
                />
              ))}
          </div>
        </>
      )}
    </section>
  );
}
