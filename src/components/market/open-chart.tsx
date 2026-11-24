"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { BrowseList, BrowseOrigin } from "~/lib/market/browse-list";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "~/components/ui/button";
import {
  chartSymbolHref,
  isForeignMarketChartSymbol,
  normalizeChartSymbol,
} from "~/lib/chart/chart-symbol";
import {
  marketSelectionHref,
  useMarketSession,
} from "~/lib/stores/market-session";
import {
  normalizeTradeDate,
  tradeChartHref,
  type TradeMarkFill,
} from "~/lib/chart/chart-trade-marks";
import type { TradeReviewRef } from "~/lib/chart/trade-review-ref";

/** In-place chart switch into a backtest review (fill → K 线). */
export type OpenChartOptions = {
  /** One-shot viewport centre, YYYY-MM-DD. */
  at?: string;
  diagnose?: string;
  cell?: string;
  scenario?: string;
  review?: TradeReviewRef;
  /** In-memory portfolio fills; never written to the URL. */
  portfolioFills?: TradeMarkFill[];
};

type OpenChart = (
  symbol: string,
  list?: BrowseList,
  options?: OpenChartOptions,
) => void;
/** Provided by the workbench: switch to the chart without a page reload. */
const OpenChartContext = createContext<OpenChart | null>(null);
/** The list a table shows, for PageUp/PageDown in the chart it opens. */
const BrowseSourceContext = createContext<{
  label: string;
  symbols: readonly string[];
  origin?: BrowseOrigin;
} | null>(null);

export const OpenChartProvider = OpenChartContext.Provider;

/** Navigation commands read the current selection without subscribing the shell. */
export function ChartNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const openChart: OpenChart = (symbol, list, options) => {
    symbol = normalizeChartSymbol(symbol) ?? symbol;
    let href = chartSymbolHref(symbol);
    // Crypto/futures share /scan but own their tab and symbol parameters.
    // Only the A-share/sector chart consumes this selection and browse list.
    if (!isForeignMarketChartSymbol(symbol)) {
      const session = useMarketSession.getState();
      session.setBrowse(list ?? null);
      const reviewing =
        options &&
        (options.review ||
          options.diagnose ||
          options.portfolioFills ||
          options.at);
      if (reviewing) {
        session.setChartMode("k");
        session.setTradeContext({
          symbol,
          at: options.at ? normalizeTradeDate(options.at) : undefined,
          diagnose: options.diagnose,
          cell: options.cell,
          scenario: options.scenario,
          review: options.review,
          portfolioFills: options.portfolioFills,
        });
      } else {
        session.clearTradeContext();
      }
      const current = useMarketSession.getState();
      href = marketSelectionHref(
        {
          ...current,
          symbol,
          // Trade marks are daily-only, so the review always opens on 日线.
          chartPeriod: reviewing ? "day" : current.chartPeriod,
          period: reviewing ? "day" : current.period,
          adjustment: options?.review ? "none" : current.adjustment,
          marketView: "chart",
        },
        current.tradeContext,
      );
    }
    router.push(href, { scroll: false });
  };
  return <OpenChartProvider value={openChart}>{children}</OpenChartProvider>;
}

export function TradeReviewChartLink({
  review,
  at,
  children = "看K线",
}: {
  review: TradeReviewRef;
  at?: string;
  children?: ReactNode;
}) {
  const openChart = useOpenChart();
  const href = tradeChartHref({ symbol: review.symbol, at, review });
  return (
    <Button asChild size="sm" variant="ghost">
      <Link
        href={href}
        prefetch={false}
        scroll={false}
        onNavigate={
          openChart
            ? (event) => {
                event.preventDefault();
                openChart(review.symbol, { at, review });
              }
            : undefined
        }
      >
        {children}
      </Link>
    </Button>
  );
}

export function BrowseSource({
  label,
  symbols,
  origin,
  children,
}: {
  label: string;
  symbols: readonly string[];
  origin?: BrowseOrigin;
  children: ReactNode;
}) {
  return (
    <BrowseSourceContext.Provider value={{ label, symbols, origin }}>
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
  return (symbol: string, options?: OpenChartOptions) => {
    const index = source?.symbols.indexOf(symbol) ?? -1;
    open(
      symbol,
      source && index >= 0
        ? {
            label: source.label,
            symbols: source.symbols,
            index,
            // Ordinary lists keep their exact shape; only typed sources add it.
            ...(source.origin ? { origin: source.origin } : {}),
          }
        : undefined,
      options,
    );
  };
}
