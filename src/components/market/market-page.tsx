"use client";
import { Suspense, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "~/trpc/react";
import { MarketView } from "../workbench/market-view";
import { useScreenVisible } from "../workbench/use-task-visible";
import { useWorkbenchNotify } from "../workbench/workbench-notify";
import { useMarketState } from "./use-market-state";
import { MarketRouteSelection } from "./market-route-selection";
import { Button } from "../ui/button";

export function MarketPage({ embedded = false }: { embedded?: boolean }) {
  const visible = useScreenVisible();
  const source = api.status.useQuery(undefined, {
    enabled: visible,
    select: (value) => value.settings.marketDataSource,
  });
  const state = useMarketState(source.data);
  const notify = useWorkbenchNotify();
  const search = useSearchParams();
  const frozenId = search.get("screenSnapshot");
  const frozen = api.savedSnapshot.useQuery(frozenId ?? "", {
    enabled: visible && !!frozenId,
    retry: false,
  });
  // Reset while the URL is ordinary so returning with Back restores the frozen
  // identity again (and rejects an in-flight ordinary response via revision).
  const restored = useRef<string | null>(null);
  const acceptFrozenSnapshot = state.load.acceptFrozenSnapshot;
  // The marker, not just the id, owns the chart: an ordinary read may return
  // the same snapshot id without being this candidate's evidence.
  const frozenLoaded =
    state.loaded?.frozenCandidate === true && state.loaded.id === frozenId;
  const matches =
    !search.get("symbol") || frozen.data?.symbol === search.get("symbol");
  useEffect(() => {
    // Hidden or ordinary route: forget this restore so showing the route again
    // (or another entry replacing the chart) re-attaches the evidence.
    if (!visible || !frozenId) {
      restored.current = null;
      return;
    }
    if (
      frozen.data?.id !== frozenId ||
      !matches ||
      (restored.current === frozenId && frozenLoaded)
    )
      return;
    acceptFrozenSnapshot(frozen.data);
    restored.current = frozenId;
  }, [
    visible,
    frozenId,
    frozen.data,
    matches,
    frozenLoaded,
    acceptFrozenSnapshot,
  ]);
  if (frozenId && (frozen.error || (!matches && frozen.data)))
    return (
      <p role="alert">
        冻结候选读取失败：{frozen.error?.message ?? "快照与所选证券不一致"}{" "}
        <Button onClick={() => void frozen.refetch()}>重试冻结候选</Button>
      </p>
    );
  if (frozenId && !frozenLoaded)
    return <p role="status">正在恢复冻结候选图表…</p>;
  return (
    <>
      {visible && (source.data || source.error) && (
        <Suspense fallback={null}>
          <MarketRouteSelection
            enterMarket={state.enterMarket}
            frozen={!!frozenId}
          />
        </Suspense>
      )}
      <MarketView
        state={state}
        notify={notify}
        embedded={embedded}
        frozen={!!frozenId}
      />
    </>
  );
}
