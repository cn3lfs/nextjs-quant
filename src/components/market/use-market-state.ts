"use client";

import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { MarketSource } from "~/lib/market/market-source";
import { marketSourceSchema } from "~/lib/market/market-source";
import type { Period } from "~/lib/domain";
import {
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
      rememberMarketUrl();
      snapshotLoad.mutate({ ...input, source }, options);
    },
    acceptSnapshot: useMarketSession.getState().acceptSnapshot,
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
    useMarketSession.setState({
      ...selection,
      symbol,
      marketSource: source,
      marketView: view ?? current.marketView,
    });
    rememberMarketUrl();
    const key = JSON.stringify([symbol, period, source]);
    const selected = current.loaded;
    // A saved candidate owns its recorded snapshot. Returning must not replace
    // that evidence with today's data or replay an in-flight load.
    const sameSnapshot =
      selected?.symbol === symbol &&
      selected.period === period &&
      (current.snapshotSource === null || current.snapshotSource === source);
    const activeRequest = request.current?.revision === current.revision;
    const conflictingRequest = activeRequest && request.current?.key !== key;
    if (
      (!sameSnapshot || conflictingRequest) &&
      !(
        request.current?.key === key &&
        request.current.revision === current.revision
      )
    )
      load.mutate({ symbol, period, source });
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
