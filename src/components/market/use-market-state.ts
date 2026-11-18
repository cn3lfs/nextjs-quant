"use client";

import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { MarketSource } from "~/lib/market/market-source";
import { marketSourceSchema } from "~/lib/market/market-source";
import type { Period } from "~/lib/domain";
import {
  planMarketRead,
  rememberMarketUrl,
  useMarketSession,
  type MarketSelection,
} from "~/lib/stores/market-session";
import { useSnapshotLoad } from "./use-snapshot-load";

/** Mounted by the retained market page only. Selection itself performs no IO. */
export function useMarketState(defaultSource?: MarketSource) {
  const state = useMarketSession(
    useShallow((s) => ({
      symbol: s.symbol,
      period: s.period,
      loaded: s.loaded,
      browse: s.browse,
      marketView: s.marketView,
      chartPeriod: s.chartPeriod,
      adjustment: s.adjustment,
      sourceOverride: s.marketSource,
      revision: s.revision,
      setSymbol: s.setSymbol,
      setPeriod: s.setPeriod,
      setBrowse: s.setBrowse,
      setMarketView: s.setMarketView,
      setChartPeriod: s.setChartPeriod,
      setAdjustment: s.setAdjustment,
      setMarketSource: s.setMarketSource,
    })),
  );
  const request = useRef<{
    key: string;
    revision: number;
    source: MarketSource;
  } | null>(null);
  const snapshotLoad = useSnapshotLoad({
    onSuccess: (loaded) => {
      if (request.current?.revision !== useMarketSession.getState().revision)
        return;
      useMarketSession.setState({
        loaded,
        snapshotSource: request.current.source,
      });
    },
  });
  const marketSource = state.sourceOverride ?? defaultSource ?? "auto";
  const requestSnapshot = (
    ...[input, options]: Parameters<typeof snapshotLoad.mutate>
  ) => {
    const source = input.source
      ? marketSourceSchema.parse(input.source)
      : marketSource;
    const revision = useMarketSession.getState().revision + 1;
    request.current = {
      key: JSON.stringify([input.symbol, input.period, source]),
      revision,
      source,
    };
    useMarketSession.setState({
      symbol: input.symbol,
      period: input.period,
      marketSource: source,
      revision,
    });
    snapshotLoad.mutate({ ...input, source }, options);
  };
  const load = {
    ...snapshotLoad,
    // A candidate selected on another page also supersedes a failed/pending
    // chart request. Its status must not leak onto the newly selected evidence.
    isPending:
      request.current?.revision === state.revision && snapshotLoad.isPending,
    isRevalidating:
      request.current?.revision === state.revision &&
      snapshotLoad.isRevalidating,
    error:
      request.current?.revision === state.revision ? snapshotLoad.error : null,
    mutate: (...[input, options]: Parameters<typeof snapshotLoad.mutate>) => {
      requestSnapshot(input, options);
      rememberMarketUrl();
    },
    acceptSnapshot: useMarketSession.getState().acceptSnapshot,
    acceptFrozenSnapshot: useMarketSession.getState().acceptFrozenSnapshot,
  };
  function enterMarket(
    requested: string | null,
    view?: "chart" | "financial",
    selection: Partial<MarketSelection> & { period?: Period } = {},
  ) {
    const current = useMarketSession.getState();
    const symbol = requested ?? current.symbol;
    const source =
      selection.marketSource ?? current.marketSource ?? defaultSource ?? "auto";
    const period = selection.period ?? current.period;
    // Frozen candidate evidence is not the live snapshot this route asks for;
    // leaving it always gets one fresh read (unless that exact read is already
    // in flight). An ordinary read still reuses its loaded snapshot.
    const plan = planMarketRead({
      loaded: current.loaded,
      snapshotSource: current.snapshotSource,
      request: request.current,
      revision: current.revision,
      requested: { symbol, period, source },
    });
    useMarketSession.setState({
      ...selection,
      symbol,
      marketSource: source,
      marketView: view ?? current.marketView,
    });
    // Reading the route must not rewrite it: a late initial load can run
    // while Next is committing the user's navigation to another Scan tab.
    if (plan.read)
      requestSnapshot(
        { symbol, period, source },
        plan.fresh ? { fresh: true } : undefined,
      );
  }
  return {
    ...state,
    marketSource,
    load,
    enterMarket,
    selectMarketSymbol: (symbol: string) =>
      load.mutate({ symbol, period: useMarketSession.getState().period }),
  };
}
export type MarketState = ReturnType<typeof useMarketState>;
