"use client";
import { Segmented } from "../panels";
import { PanelVisibility, usePanelVisible } from "../workbench/keep-alive";
import { HoldingsCorrelationContainer } from "../portfolio/holdings-correlation-container";
import { useState } from "react";
import type { PaginationState, SortingState } from "@tanstack/react-table";
import { api, type RouterInputs } from "~/trpc/react";
import { PositionRiskResults } from "./position-risk-results";
import { Button } from "../ui/button";
export function PositionRiskContainer({ account }: { account: string }) {
  const visible = usePanelVisible();
  const [riskView, setRiskView] = useState<"concentration" | "correlation">(
    "concentration",
  );
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
    {
      enabled: !!account && visible && riskView === "concentration",
      retry: false,
    },
  );
  return (
    <section aria-label="持仓风险" className="space-y-3">
      <Segmented
        label="持仓风险分析"
        value={riskView}
        onChange={setRiskView}
        options={[
          { value: "concentration", label: "持仓集中度" },
          { value: "correlation", label: "持仓相关性" },
        ]}
      />
      <div hidden={riskView !== "concentration"} className="space-y-3">
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
            />
          )
        )}
      </div>
      <PanelVisibility visible={riskView === "correlation"}>
        <div hidden={riskView !== "correlation"}>
          <HoldingsCorrelationContainer account={account} />
        </div>
      </PanelVisibility>
    </section>
  );
}
