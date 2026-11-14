"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { BrowseList } from "~/lib/market/browse-list";
import { useRouter } from "next/navigation";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import {
  marketSelectionHref,
  useMarketSession,
} from "~/lib/stores/market-session";

type OpenChart = (symbol: string, list?: BrowseList) => void;
/** Provided by the workbench: switch to the chart without a page reload. */
const OpenChartContext = createContext<OpenChart | null>(null);
/** The list a table shows, for PageUp/PageDown in the chart it opens. */
const BrowseSourceContext = createContext<{
  label: string;
  symbols: readonly string[];
} | null>(null);

export const OpenChartProvider = OpenChartContext.Provider;

/** Navigation commands read the current selection without subscribing the shell. */
export function ChartNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const openChart: OpenChart = (symbol, list) => {
    let href = chartSymbolHref(symbol);
    if (href.startsWith("/market?")) {
      const session = useMarketSession.getState();
      session.setBrowse(list ?? null);
      href = marketSelectionHref({ ...session, symbol, marketView: "chart" });
    }
    router.push(href, { scroll: false });
  };
  return <OpenChartProvider value={openChart}>{children}</OpenChartProvider>;
}

export function BrowseSource({
  label,
  symbols,
  children,
}: {
  label: string;
  symbols: readonly string[];
  children: ReactNode;
}) {
  return (
    <BrowseSourceContext.Provider value={{ label, symbols }}>
      {children}
    </BrowseSourceContext.Provider>
  );
}

/**
 * Opens `symbol` in the workbench chart, remembering the surrounding table as
 * the browse list. Null outside the workbench, where links navigate normally.
 */
export function useOpenChart() {
  const open = useContext(OpenChartContext);
  const source = useContext(BrowseSourceContext);
  if (!open) return null;
  return (symbol: string) => {
    const index = source?.symbols.indexOf(symbol) ?? -1;
    open(
      symbol,
      source && index >= 0
        ? { label: source.label, symbols: source.symbols, index }
        : undefined,
    );
  };
}
