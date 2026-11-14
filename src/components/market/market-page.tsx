"use client";
import { Suspense } from "react";
import { api } from "~/trpc/react";
import { MarketView } from "../workbench/market-view";
import { useTaskVisible } from "../workbench/use-task-visible";
import { useWorkbenchNotify } from "../workbench/workbench-notify";
import { useMarketState } from "./use-market-state";
import { MarketRouteSelection } from "./market-route-selection";

export function MarketPage() {
  const visible = useTaskVisible();
  const source = api.status.useQuery(undefined, {
    enabled: visible,
    select: (value) => value.settings.marketDataSource,
  });
  const state = useMarketState(source.data);
  const notify = useWorkbenchNotify();
  return (
    <>
      {visible && (source.data || source.error) && (
        <Suspense fallback={null}>
          <MarketRouteSelection enterMarket={state.enterMarket} />
        </Suspense>
      )}
      <MarketView state={state} notify={notify} />
    </>
  );
}
