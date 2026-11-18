import { create } from "zustand";
import type { Period, Snapshot } from "~/lib/domain";
import type { BrowseList } from "~/lib/market/browse-list";
import type { MarketSource } from "~/lib/market/market-source";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartAdjustment } from "~/lib/chart/chart-adjustment";

export type MarketSelection = {
  symbol: string;
  chartPeriod: ChartPeriod;
  marketSource: MarketSource | null;
  adjustment: ChartAdjustment;
  marketView: "chart" | "financial";
};

/** Client-only evidence marker; persisted and server snapshots stay plain. */
export type MarketSnapshot = Snapshot & { frozenCandidate?: true };

export type MarketReadPlan = { read: false } | { read: true; fresh: boolean };

/**
 * Which read a route entry starts. Frozen candidate evidence is not the
 * ordinary snapshot the route asks for: leaving it always bypasses the cache,
 * even when today's snapshot happens to share the symbol and period. An
 * in-flight request for the same key is never duplicated.
 */
export function planMarketRead(input: {
  loaded: MarketSnapshot | null;
  snapshotSource: MarketSource | null;
  request: { key: string; revision: number } | null;
  revision: number;
  requested: { symbol: string; period: Period; source: MarketSource };
}): MarketReadPlan {
  const key = JSON.stringify([
    input.requested.symbol,
    input.requested.period,
    input.requested.source,
  ]);
  if (input.request?.key === key && input.request.revision === input.revision)
    return { read: false };
  if (input.loaded?.frozenCandidate) return { read: true, fresh: true };
  const sameSnapshot =
    input.loaded?.symbol === input.requested.symbol &&
    input.loaded.period === input.requested.period &&
    (input.snapshotSource === null ||
      input.snapshotSource === input.requested.source);
  const conflictingRequest =
    input.request !== null &&
    input.request.revision === input.revision &&
    input.request.key !== key;
  return sameSnapshot && !conflictingRequest
    ? { read: false }
    : { read: true, fresh: false };
}

/** Only shareable selection goes into history; snapshots/browse lists stay in memory. */
export function marketSelectionHref(
  selection: MarketSelection & { period?: Period },
) {
  const search = new URLSearchParams({
    symbol: selection.symbol,
    period: selection.chartPeriod,
    adjustment: selection.adjustment,
  });
  if (selection.marketSource) search.set("source", selection.marketSource);
  if (selection.period === "5m") search.set("base", "5m");
  if (selection.marketView === "financial") search.set("view", "financial");
  return `/scan?${search}`;
}

export function rememberMarketUrl() {
  if (typeof window === "undefined" || window.location.pathname !== "/scan")
    return;
  const current = new URLSearchParams(window.location.search);
  if (current.has("tab") && current.get("tab") !== "formula") return;
  const url = new URL(
    marketSelectionHref(useMarketSession.getState()),
    window.location.origin,
  );
  for (const key of [
    "candidate",
    "strategy",
    "tab",
    "job",
    "screenSnapshot",
    "screenJob",
  ])
    if (current.has(key)) url.searchParams.set(key, current.get(key)!);
  const href = url.pathname + url.search;
  if (`${window.location.pathname}${window.location.search}` !== href)
    window.history.replaceState(null, "", href + window.location.hash);
}

type MarketSession = MarketSelection & {
  period: Period;
  loaded: MarketSnapshot | null;
  snapshotSource: MarketSource | null;
  browse: BrowseList | null;
  revision: number;
  setSymbol: (symbol: string) => void;
  setPeriod: (period: Period) => void;
  setBrowse: (browse: BrowseList | null) => void;
  setChartPeriod: (chartPeriod: ChartPeriod) => void;
  setMarketSource: (marketSource: MarketSource) => void;
  setAdjustment: (adjustment: ChartAdjustment) => void;
  setMarketView: (marketView: MarketSelection["marketView"]) => void;
  /** Accept an ordinary read; any frozen evidence marker is dropped. */
  acceptSnapshot: (snapshot: Snapshot) => void;
  /** Restore a saved candidate; only MarketPage's frozen URL calls this. */
  acceptFrozenSnapshot: (snapshot: Snapshot) => void;
};

// Server data/view settings keep their existing query-cache owners. This store
// owns the cross-page selection and the exact selected candidate, never the shell.
export const useMarketSession = create<MarketSession>((set) => {
  const accept = (loaded: MarketSnapshot) => {
    // Formula candidates predate requestedSource. Their recorded local origin
    // must own list browsing even before the settings query has completed.
    const source =
      loaded.requestedSource ??
      (loaded.source === "tdx-local" ? "local" : null);
    set((state) => ({
      loaded,
      symbol: loaded.symbol,
      period: loaded.period,
      chartPeriod: loaded.period,
      adjustment: loaded.adjustment ?? "none",
      snapshotSource: source,
      marketSource: source ?? state.marketSource,
      marketView: "chart",
      // Bumping here also rejects a live response still in flight from the
      // ordinary URL the user just left.
      revision: state.revision + 1,
    }));
    rememberMarketUrl();
  };
  return {
    symbol: "sh600519",
    period: "day",
    chartPeriod: "day",
    marketSource: null,
    adjustment: "none",
    marketView: "chart",
    loaded: null,
    snapshotSource: null,
    browse: null,
    revision: 0,
    setSymbol: (symbol) => set({ symbol }),
    setPeriod: (period) => set({ period }),
    setBrowse: (browse) => set({ browse }),
    setChartPeriod: (chartPeriod) => {
      set({ chartPeriod });
      rememberMarketUrl();
    },
    setMarketSource: (marketSource) => {
      set({ marketSource });
      rememberMarketUrl();
    },
    setAdjustment: (adjustment) => {
      set({ adjustment });
      rememberMarketUrl();
    },
    setMarketView: (marketView) => {
      set({ marketView });
      rememberMarketUrl();
    },
    acceptSnapshot: (snapshot) => accept(snapshot),
    acceptFrozenSnapshot: (snapshot) =>
      accept({ ...snapshot, frozenCandidate: true }),
  };
});
