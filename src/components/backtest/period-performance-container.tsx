"use client";
import { useTaskVisible } from "../workbench/use-task-visible";

import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import { PeriodPerformanceResults } from "./period-performance-results";
import { Button } from "../ui/button";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import type { PerformanceBasis } from "~/lib/backtest/daily-performance";

export function PeriodPerformanceContainer({ account }: { account: string }) {
  const visible = useTaskVisible();
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "id", desc: false },
  ]);
  const [basis, setBasis] = useState<PerformanceBasis>("compound");
  const [open, setOpen] = useState(false);
  const page = {
    ...pagination,
    basis,
    sort: (sorting[0]?.id ??
      "id") as RouterInputs["tradeReviewPeriodPerformance"]["sort"],
    desc: sorting[0]?.desc ?? false,
  };
  const query = api.tradeReviewPeriodPerformance.useQuery(
    { ...page, account },
    { enabled: visible && !!account, retry: false },
  );
  return (
    <section className="space-y-3" aria-label="分段与收益矩阵">
      <Tabs
        value={basis}
        onValueChange={(value) => {
          setBasis(value as PerformanceBasis);
          setPagination((p) => ({ ...p, pageIndex: 0 }));
        }}
      >
        <TabsList aria-label="分段收益口径">
          <TabsTrigger value="compound">复利</TabsTrigger>
          <TabsTrigger value="simple">单利对照</TabsTrigger>
        </TabsList>
      </Tabs>
      {query.isLoading && <p role="status">正在计算分段表现…</p>}
      {query.error ? (
        <div role="alert">
          <p>{query.error.message}</p>
          <Button onClick={() => void query.refetch()}>重新读取分段表现</Button>
        </div>
      ) : (
        query.data && (
          <PeriodPerformanceResults
            data={query.data}
            open={open}
            onOpenChange={setOpen}
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
        )
      )}
    </section>
  );
}
