"use client";

import { useState } from "react";
import type { PaginationState } from "@tanstack/react-table";
import type { CashReconciliationStatus } from "~/lib/cash-reconciliation";
import { api } from "~/trpc/react";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import {
  CashReconciliationResults,
  cashReconciliationLabels,
} from "./cash-reconciliation-results";

export function CashReconciliationContainer({ account }: { account: string }) {
  const utils = api.useUtils();
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 20,
  });
  const [status, setStatus] = useState<"all" | CashReconciliationStatus>("all");
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const query = api.tradeReviewCashReconciliation.useQuery(
    { account, ...pagination, status },
    { retry: false },
  );
  const download = async () => {
    setExporting(true);
    setMessage("");
    setError("");
    try {
      const result = await utils.tradeReviewCashReconciliationExport.fetch(
        { account },
        { staleTime: 0 },
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json;charset=utf-8",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = "现金核对证据.json";
      try {
        document.body.appendChild(link);
        link.click();
        setMessage("已导出全部日期的结构化证据，不限筛选或当前页。");
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="space-y-4" aria-label="现金核对">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">现金核对</h2>
        <Button
          variant="outline"
          disabled={
            exporting || query.isFetching || !query.data || !!query.error
          }
          onClick={() => void download()}
        >
          {exporting ? "正在导出…" : "导出完整核对证据"}
        </Button>
      </div>
      <Tabs
        value={status}
        onValueChange={(value) => {
          setStatus(value as typeof status);
          setPagination((current) => ({ ...current, pageIndex: 0 }));
        }}
      >
        <TabsList aria-label="现金核对状态筛选" className="h-auto flex-wrap">
          <TabsTrigger value="all">全部</TabsTrigger>
          {(
            Object.keys(cashReconciliationLabels) as CashReconciliationStatus[]
          ).map((value) => (
            <TabsTrigger key={value} value={value}>
              {cashReconciliationLabels[value]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      {query.isFetching && <p role="status">正在核对现金…</p>}
      {query.error ? (
        <div role="alert">
          {query.error.message}
          <Button variant="outline" onClick={() => void query.refetch()}>
            重试现金核对
          </Button>
        </div>
      ) : query.data ? (
        <CashReconciliationResults
          data={query.data}
          table={{
            pagination,
            onPaginationChange: setPagination,
            loading: query.isFetching,
          }}
        />
      ) : null}
    </section>
  );
}
