"use client";

import { useRef, useState } from "react";
import type { Period, Snapshot } from "~/lib/domain";
import type { BrowseList } from "~/lib/market/browse-list";
import type { MarketSource } from "~/lib/market/market-source";
import { useSnapshotLoad } from "./use-snapshot-load";

/** Session chart selection survives navigation; mounting the state performs no IO. */
export function useMarketState(defaultSource?: MarketSource) {
  const [symbol, setSymbol] = useState("sh600519");
  const [period, setPeriod] = useState<Period>("day");
  const [loaded, setLoaded] = useState<Snapshot | null>(null);
  const [browse, setBrowse] = useState<BrowseList | null>(null);
  const [marketView, setView] = useState<"chart" | "financial">("chart");
  const [sourceOverride, setMarketSource] = useState<MarketSource | null>(null);
  const selectedSymbol = useRef<string | null>(null);
  const requestSource = sourceOverride ?? defaultSource;
  const marketSource = requestSource ?? "auto";
  const snapshotLoad = useSnapshotLoad({
    onSuccess: (snapshot) => {
      setLoaded(snapshot);
      setSymbol(snapshot.symbol);
    },
    // Chart errors belong to the chart's inline error/retry state, not a global toast.
  });
  function rememberSelection(next: string) {
    selectedSymbol.current = next;
    setSymbol(next);
    if (window.location.pathname !== "/market") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("symbol") === next) return;
    url.searchParams.set("symbol", next);
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  const load = {
    ...snapshotLoad,
    mutate: (...[input, options]: Parameters<typeof snapshotLoad.mutate>) => {
      rememberSelection(input.symbol);
      snapshotLoad.mutate(
        { ...input, source: input.source ?? requestSource },
        options,
      );
    },
    acceptSnapshot: (snapshot: Snapshot) => {
      rememberSelection(snapshot.symbol);
      setPeriod(snapshot.period);
      snapshotLoad.acceptSnapshot(snapshot);
    },
  };
  function setMarketView(view: "chart" | "financial") {
    setView(view);
    if (window.location.pathname !== "/market") return;
    const url = new URL(window.location.href);
    if (view === "financial") url.searchParams.set("view", view);
    else url.searchParams.delete("view");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }
  function enterMarket(requested: string | null, view?: "chart" | "financial") {
    setMarketView(view ?? marketView);
    if (
      !selectedSymbol.current ||
      (requested && requested !== selectedSymbol.current)
    ) {
      load.mutate({ symbol: requested ?? symbol, period });
    } else {
      // A saved candidate or cross-page selection already owns the snapshot.
      rememberSelection(selectedSymbol.current);
    }
  }
  const last = loaded?.bars.at(-1);
  const previous = loaded?.bars.at(-2);
  return {
    symbol,
    setSymbol,
    period,
    setPeriod,
    loaded,
    browse,
    setBrowse,
    marketView,
    setMarketView,
    marketSource,
    setMarketSource,
    load,
    enterMarket,
    selectMarketSymbol: (next: string) => load.mutate({ symbol: next, period }),
    last,
    change:
      last && previous ? (last.close / previous.close - 1) * 100 : undefined,
  };
}
