"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { readChartSymbolParam } from "~/lib/chart/chart-symbol";

/** Mounted only on /market, inside Suspense so the shared shell stays prerenderable. */
export function MarketRouteSelection({
  enterMarket,
}: {
  enterMarket: (symbol: string | null, view?: "chart" | "financial") => void;
}) {
  const search = useSearchParams();
  const symbol = readChartSymbolParam(search.toString());
  const view = search.get("view") === "financial" ? "financial" : "chart";
  const enter = useRef(enterMarket);
  enter.current = enterMarket;
  // Only navigation initiates a load. A pending response or local edit must not
  // replay an older URL while Next is committing the replacement search params.
  useEffect(() => {
    enter.current(symbol, view);
  }, [symbol, view]);
  return null;
}
