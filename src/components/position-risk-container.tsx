"use client";
import { HoldingsCorrelationContainer } from "./holdings-correlation-container";
import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import { PositionRiskResults } from "./position-risk-results";
import { Button } from "./ui/button";
export function PositionRiskContainer({ account }: { account: string }) {
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "date", desc: true },
  ]);
  const query = api.tradeReviewPositionRisk.useQuery(
    {
      account,
      ...pagination,
      sort: (sorting[0]?.id ??
        "date") as RouterInputs["tradeReviewPositionRisk"]["sort"],
      desc: sorting[0]?.desc ?? true,
    },
    { enabled: !!account, retry: false },
  );
  return (
    <section aria-label="持仓集中度" className="space-y-3">
      {query.isLoading && <p role="status">正在计算持仓集中度…</p>}
      {query.error ? (
        <div role="alert">
          <p>{query.error.message}</p>
          <Button onClick={() => void query.refetch()}>
            重新读取持仓集中度
          </Button>
        </div>
      ) : (
        query.data && (
          <PositionRiskResults
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
          >
            <HoldingsCorrelationContainer account={account} />
          </PositionRiskResults>
        )
      )}
    </section>
  );
}
