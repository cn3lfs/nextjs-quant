"use client";

import { useRef, useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs, type RouterOutputs } from "~/trpc/react";
import type { CostMethod } from "~/lib/trade-review";
import {
  TradeReviewImport,
  type DeliveryDraft,
  type DeliveryPreview,
} from "./trade-review-import";
import { TradeReviewBatches } from "./trade-review-batches";
import { TradeReviewResults } from "./trade-review-results";
import { PeriodPerformanceContainer } from "./period-performance-container";
import { ExecutionQualityContainer } from "./execution-quality-container";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function TradeReviewContainer() {
  const utils = api.useUtils();
  const [directory, setDirectory] = useState("");
  const [files, setFiles] = useState<RouterOutputs["deliveryFiles"]>();
  const [draft, setDraft] = useState<DeliveryDraft>({
    path: "",
    account: "",
    source: "generic",
  });
  const [preview, setPreview] = useState<DeliveryPreview>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [accountDraft, setAccountDraft] = useState("");
  const [account, setAccount] = useState("");
  const [method, setMethod] = useState<CostMethod>("movingAverage");
  const [monthPagination, setMonthPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 12,
  });
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "openingDate", desc: false },
  ]);
  const [pointPagination, setPointPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [pointSorting, setPointSorting] = useState<SortingState>([
    { id: "fillIndex", desc: false },
  ]);
  const [attributionPagination, setAttributionPagination] =
    useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [attributionSorting, setAttributionSorting] = useState<SortingState>([
    { id: "dimension", desc: false },
  ]);
  const [drawdownsOpen, setDrawdownsOpen] = useState(false);
  const [drawdownPagination, setDrawdownPagination] = useState<PaginationState>(
    { pageIndex: 0, pageSize: 10 },
  );
  const [drawdownSorting, setDrawdownSorting] = useState<SortingState>([
    { id: "drawdown", desc: true },
  ]);
  const resetDetailPages = () => {
    setDrawdownsOpen(false);
    setDrawdownPagination((p) => ({ ...p, pageIndex: 0 }));
    setPointPagination((p) => ({ ...p, pageIndex: 0 }));
    setAttributionPagination((p) => ({ ...p, pageIndex: 0 }));
    setMonthPagination((p) => ({ ...p, pageIndex: 0 }));
  };
  const batches = api.deliveryBatches.useQuery();
  const review = api.tradeReviewSnapshot.useQuery(
    {
      account,
      method,
      ...pagination,
      pointPageIndex: pointPagination.pageIndex,
      pointPageSize: pointPagination.pageSize,
      pointSort: pointSorting[0]
        ?.id as RouterInputs["tradeReviewSnapshot"]["pointSort"],
      pointDesc: pointSorting[0]?.desc ?? false,
      attributionPageIndex: attributionPagination.pageIndex,
      attributionPageSize: attributionPagination.pageSize,
      attributionSort: attributionSorting[0]
        ?.id as RouterInputs["tradeReviewSnapshot"]["attributionSort"],
      attributionDesc: attributionSorting[0]?.desc ?? false,
      drawdownPageIndex: drawdownPagination.pageIndex,
      drawdownPageSize: drawdownPagination.pageSize,
      drawdownSort: drawdownSorting[0]
        ?.id as RouterInputs["tradeReviewSnapshot"]["drawdownSort"],
      drawdownDesc: drawdownSorting[0]?.desc ?? true,
      monthPageIndex: monthPagination.pageIndex,
      sort: sorting[0]?.id as RouterInputs["tradeReviewSnapshot"]["sort"],
      desc: sorting[0]?.desc ?? false,
    },
    { enabled: !!account, retry: false },
  );
  const importMutation = api.deliveryImport.useMutation();
  const revokeMutation = api.deliveryRevoke.useMutation();
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    setPreview(undefined);
    await Promise.all([
      utils.deliveryBatches.invalidate(),
      utils.tradeReviewSnapshot.invalidate(),
      utils.tradeReviewPeriodPerformance.invalidate(),
      utils.tradeReviewExecution.invalidate(),
    ]);
  };
  return (
    <div className="space-y-8">
      {error && (
        <p role="alert" className="rounded-lg border border-destructive p-3">
          {error}。请核对后重试。
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <TradeReviewImport
        directory={directory}
        onDirectoryChange={(value) => {
          setDirectory(value);
          setFiles(undefined);
          setDraft({ ...draft, path: "" });
          setPreview(undefined);
        }}
        onList={() => {
          void run(async () => {
            setPreview(undefined);
            setFiles(await utils.deliveryFiles.fetch(directory));
          });
        }}
        files={files}
        draft={draft}
        onDraftChange={(value) => {
          setDraft(value);
          setPreview(undefined);
        }}
        busy={busy}
        preview={preview}
        onPreview={() => {
          void run(async () => {
            setPreview(undefined);
            setPreview(
              await utils.deliveryPreview.fetch(draft, { staleTime: 0 }),
            );
          });
        }}
        onConfirm={() => {
          if (preview && !preview.summary.conflict)
            void run(async () => {
              const result = await importMutation.mutateAsync({
                ...draft,
                hash: preview.fileHash,
              });
              await refresh();
              setMessage(
                `导入完成：新增成交 ${result.fills} 笔、现金流 ${result.cashFlows} 笔，跳过重复 ${result.duplicate} 笔${result.alreadyImported ? "；该文件已导入" : ""}。`,
              );
              setAccountDraft(draft.account);
              setAccount(draft.account);
              resetDetailPages();
              setMonthPagination((p) => ({ ...p, pageIndex: 0 }));
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            });
        }}
      />
      {batches.isLoading && <p role="status">正在加载批次…</p>}
      {batches.error && (
        <div role="alert">
          {batches.error.message}
          <Button variant="outline" onClick={() => void batches.refetch()}>
            重试批次
          </Button>
        </div>
      )}
      {batches.data && (
        <TradeReviewBatches
          batches={batches.data}
          busy={busy}
          onRevoke={async (id) => {
            const success = await run(async () => {
              const result = await revokeMutation.mutateAsync(id);
              await refresh();
              resetDetailPages();
              setPagination((p) => ({ ...p, pageIndex: 0 }));
              setMessage(
                `撤销完成：删除成交 ${result.fills} 笔、现金流 ${result.cashFlows} 笔。`,
              );
            });
            return success;
          }}
        />
      )}
      <section className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="review-account">复盘账户别名</Label>
            <Input
              id="review-account"
              value={accountDraft}
              maxLength={64}
              disabled={busy}
              onChange={(e) => setAccountDraft(e.target.value)}
            />
          </div>
          <Button
            disabled={busy || !accountDraft.trim()}
            onClick={() => {
              const next = accountDraft.trim();
              setPagination((p) => ({ ...p, pageIndex: 0 }));
              setAccount(next);
              resetDetailPages();
              setMonthPagination((p) => ({ ...p, pageIndex: 0 }));
              if (next === account) void review.refetch();
            }}
          >
            查看复盘
          </Button>
          <Button
            variant="outline"
            disabled={busy || !account || review.isFetching || !review.data}
            onClick={() => {
              void run(async () => {
                const json = await utils.tradeReviewExport.fetch(
                  { account },
                  { staleTime: 0 },
                );
                const url = URL.createObjectURL(
                  new Blob([json], { type: "application/json;charset=utf-8" }),
                );
                const link = document.createElement("a");
                link.href = url;
                link.download = `交易复盘-${account.replace(/[<>:"/\\|?*]/g, "_")}.json`;
                try {
                  document.body.appendChild(link);
                  link.click();
                  setMessage("已生成完整复盘 JSON。");
                } finally {
                  link.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
              });
            }}
          >
            导出 JSON
          </Button>
        </div>
        {!account && <p>输入已导入的账户别名后查看复盘。</p>}
        {review.isFetching && <p role="status">正在读取行情并计算复盘…</p>}
        {review.error && (
          <div role="alert">
            {review.error.message}
            <Button variant="outline" onClick={() => void review.refetch()}>
              重试复盘
            </Button>
          </div>
        )}
        {review.data && !review.error && (
          <TradeReviewResults
            periodPerformance={
              <PeriodPerformanceContainer
                key={`${account}:${method}:${batches.data?.map((b) => b.id).join(",")}`}
                source={{ account }}
              />
            }
            data={review.data}
            drawdownsOpen={drawdownsOpen}
            onDrawdownsOpenChange={(open) => {
              setDrawdownsOpen(open);
              if (!open) setDrawdownPagination({ pageIndex: 0, pageSize: 10 });
            }}
            drawdownTable={{
              pagination: drawdownPagination,
              sorting: drawdownSorting,
              onPaginationChange: setDrawdownPagination,
              onSortingChange: (value) => {
                setDrawdownSorting(value);
                setDrawdownPagination((p) => ({ ...p, pageIndex: 0 }));
              },
            }}
            pointTable={{
              pagination: pointPagination,
              sorting: pointSorting,
              onPaginationChange: setPointPagination,
              onSortingChange: (value) => {
                setPointSorting(value);
                setPointPagination((p) => ({ ...p, pageIndex: 0 }));
              },
            }}
            attributionTable={{
              pagination: attributionPagination,
              sorting: attributionSorting,
              onPaginationChange: setAttributionPagination,
              onSortingChange: (value) => {
                setAttributionSorting(value);
                setAttributionPagination((p) => ({ ...p, pageIndex: 0 }));
              },
            }}
            method={method}
            onMethodChange={(value) => {
              setMethod(value);
              resetDetailPages();
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            pagination={pagination}
            monthPagination={monthPagination}
            onMonthPaginationChange={setMonthPagination}
            sorting={sorting}
            onPaginationChange={setPagination}
            onSortingChange={(value) => {
              setSorting(value);
              setPagination((p) => ({ ...p, pageIndex: 0 }));
            }}
            loading={review.isFetching}
          />
        )}
        {review.data && !review.error && (
          <ExecutionQualityContainer
            key={`${account}:${batches.data?.map((b) => b.id).join(",")}`}
            account={account}
          />
        )}
      </section>
    </div>
  );
}
