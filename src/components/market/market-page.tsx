"use client";
import { Suspense, useEffect, useState } from "react";
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
  const [restored, setRestored] = useState<string | null>(null);
  const acceptSnapshot = state.load.acceptSnapshot;
  const matches =
    !search.get("symbol") || frozen.data?.symbol === search.get("symbol");
  useEffect(() => {
    if (
      !visible ||
      !frozenId ||
      frozen.data?.id !== frozenId ||
      !matches ||
      (restored === frozenId && state.loaded?.id === frozenId)
    )
      return;
    acceptSnapshot(frozen.data);
    setRestored(frozenId);
  }, [
    visible,
    frozenId,
    frozen.data,
    matches,
    restored,
    state.loaded?.id,
    acceptSnapshot,
  ]);
  if (frozenId && (frozen.error || (!matches && frozen.data)))
    return (
      <p role="alert">
        冻结候选读取失败：{frozen.error?.message ?? "快照与所选证券不一致"}{" "}
        <Button onClick={() => void frozen.refetch()}>重试冻结候选</Button>
      </p>
    );
  if (frozenId && (restored !== frozenId || state.loaded?.id !== frozenId))
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
