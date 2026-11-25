import { create } from "zustand";
import type { Period, Snapshot } from "~/lib/domain";
import type { BrowseList } from "~/lib/market/browse-list";
import type { MarketSource } from "~/lib/market/market-source";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartAdjustment } from "~/lib/chart/chart-adjustment";
import {
  normalizeTradeDate,
  normalizeTradeSymbol,
  tradeChartHref,
  type TradeMarkFill,
} from "~/lib/chart/chart-trade-marks";
import type { TradeReviewRef } from "~/lib/chart/trade-review-ref";

/**
 * Where the K 线 trade marks come from. `symbol` is the symbol the fills
 * belong to; the overlay is only shown when the active chart matches it.
 * `focusToken` makes `at` one-shot: the chart centres once per token and never
 * writes that window into the persistent viewport store.
 */
export type MarketTradeContext = {
  symbol: string;
  at?: string;
  diagnose?: string;
  cell?: string;
  scenario?: string;
  review?: TradeReviewRef;
  /** In-memory portfolio fills (never persisted). */
  portfolioFills?: TradeMarkFill[];
  visible: boolean;
  focusToken: number;
  focusPending: boolean;
};

export type MarketTradeContextInput = Omit<
  MarketTradeContext,
  "visible" | "focusToken" | "focusPending"
>;

export type MarketSelection = {
  symbol: string;
  chartPeriod: ChartPeriod;
  marketSource: MarketSource | null;
  adjustment: ChartAdjustment;
  marketView: "chart" | "financial";
};

/** The main chart is either K 线 at `chartPeriod` or 分时, a mode rather than
 *  a period. One owner keeps the toolbar and the workspace from disagreeing. */
export type ChartMode = "k" | "intraday";

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
  tradeContext?: MarketTradeContext | null,
) {
  const search = new URLSearchParams({
    symbol: selection.symbol,
    period: selection.chartPeriod,
    adjustment: selection.adjustment,
  });
  if (selection.marketSource) search.set("source", selection.marketSource);
  if (selection.period === "5m") search.set("base", "5m");
  if (selection.marketView === "financial") search.set("view", "financial");
  // Trade-review context survives ordinary chart edits and a symbol switch
  // away/back, but it is only written for the symbol its fills belong to.
  if (
    tradeContext?.visible &&
    normalizeTradeSymbol(tradeContext.symbol) ===
      normalizeTradeSymbol(selection.symbol)
  ) {
    if (tradeContext.at) search.set("at", normalizeTradeDate(tradeContext.at));
    if (tradeContext.diagnose) search.set("diagnose", tradeContext.diagnose);
    if (tradeContext.cell) search.set("cell", tradeContext.cell);
    if (tradeContext.scenario) search.set("scenario", tradeContext.scenario);
    if (tradeContext.review) {
      const reviewUrl = tradeChartHref({
        symbol: selection.symbol,
        review: tradeContext.review,
      });
      for (const [key, value] of new URLSearchParams(reviewUrl.split("?")[1]))
        if (key.startsWith("review")) search.set(key, value);
    }
  }
  return `/scan?${search}`;
}

export function rememberMarketUrl() {
  if (typeof window === "undefined" || window.location.pathname !== "/scan")
    return;
  const current = new URLSearchParams(window.location.search);
  if (current.has("tab") && current.get("tab") !== "formula") return;
  const state = useMarketSession.getState();
  const url = new URL(
    marketSelectionHref(state, state.tradeContext),
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
  chartMode: ChartMode;
  loaded: MarketSnapshot | null;
  snapshotSource: MarketSource | null;
  browse: BrowseList | null;
  revision: number;
  tradeContext: MarketTradeContext | null;
  /** Replace the trade-review context; a changed fill set bumps `focusToken`. */
  setTradeContext: (context: MarketTradeContextInput) => void;
  consumeTradeFocus: (token: number) => boolean;
  /** Hide/show marks without discarding the fills (toggle off/on stays clean). */
  setTradeMarksVisible: (visible: boolean) => void;
  clearTradeContext: () => void;
  setSymbol: (symbol: string) => void;
  setPeriod: (period: Period) => void;
  setBrowse: (
    browse: BrowseList | null,
    options?: { preserveActivation: true },
  ) => void;
  setChartPeriod: (chartPeriod: ChartPeriod) => void;
  setChartMode: (chartMode: ChartMode) => void;
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
  let focusToken = 0;
  let browseActivation = 0;
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
    chartMode: "k",
    marketSource: null,
    adjustment: "none",
    marketView: "chart",
    loaded: null,
    snapshotSource: null,
    browse: null,
    revision: 0,
    tradeContext: null,
    setTradeContext: (context) => {
      set({
        tradeContext: {
          ...context,
          visible: true,
          focusToken: ++focusToken,
          focusPending: Boolean(context.at),
        },
      });
    },
    consumeTradeFocus: (token) => {
      let consumed = false;
      set((state) => {
        const context = state.tradeContext;
        if (!context?.focusPending || context.focusToken !== token)
          return state;
        consumed = true;
        return { tradeContext: { ...context, focusPending: false } };
      });
      return consumed;
    },
    setTradeMarksVisible: (visible) => {
      set((state) =>
        state.tradeContext && state.tradeContext.visible !== visible
          ? { tradeContext: { ...state.tradeContext, visible } }
          : state,
      );
      rememberMarketUrl();
    },
    clearTradeContext: () => {
      set((state) => (state.tradeContext ? { tradeContext: null } : state));
    },
    setSymbol: (symbol) => set({ symbol }),
    setPeriod: (period) => set({ period }),
    setBrowse: (browse, options) =>
      set({
        browse:
          browse && !options?.preserveActivation
            ? { ...browse, activationId: ++browseActivation }
            : browse,
      }),
    setChartPeriod: (chartPeriod) => {
      set({ chartPeriod });
      rememberMarketUrl();
    },
    // 分时 is not a period, so it never reaches the URL or a snapshot read.
    setChartMode: (chartMode) => set({ chartMode }),
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
