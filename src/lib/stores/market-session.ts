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
  return `/market?${search}`;
}

export function rememberMarketUrl() {
  if (typeof window === "undefined" || window.location.pathname !== "/market")
    return;
  const href = marketSelectionHref(useMarketSession.getState());
  if (`${window.location.pathname}${window.location.search}` !== href)
    window.history.replaceState(null, "", href + window.location.hash);
}

type MarketSession = MarketSelection & {
  period: Period;
  loaded: Snapshot | null;
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
  acceptSnapshot: (snapshot: Snapshot) => void;
};

// Server data/view settings keep their existing query-cache owners. This store
// owns the cross-page selection and the exact selected candidate, never the shell.
export const useMarketSession = create<MarketSession>((set) => ({
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
  acceptSnapshot: (loaded) => {
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
      revision: state.revision + 1,
    }));
    rememberMarketUrl();
  },
}));
