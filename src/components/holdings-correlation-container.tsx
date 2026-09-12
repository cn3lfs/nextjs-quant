"use client";
import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api } from "~/trpc/react";
import { HoldingsCorrelationResults } from "./holdings-correlation-results";
import { Button } from "./ui/button";
export function HoldingsCorrelationContainer({ account }: { account: string }) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "symbol", desc: false },
  ]);
  const query = api.tradeReviewHoldingsCorrelation.useQuery(
    { account, ...pagination, desc: sorting[0]?.desc ?? false },
    { enabled: !!account, retry: false },
  );
  if (query.error)
    return (
      <div role="alert">
        {query.error.message}
        <Button onClick={() => void query.refetch()}>重新读取持仓相关性</Button>
      </div>
    );
  if (!query.data) return <p role="status">正在计算持仓相关性…</p>;
  return (
    <HoldingsCorrelationResults
      data={query.data}
      table={{
        pagination,
        sorting,
        onPaginationChange: setPagination,
        onSortingChange: (update) => {
          setSorting(update);
          setPagination((p) => ({ ...p, pageIndex: 0 }));
        },
        loading: query.isFetching,
      }}
    />
  );
}
