"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { readChartSymbolParam } from "~/lib/chart/chart-symbol";
import { chartPeriodSchema } from "~/lib/chart/chart-view";
import { chartAdjustmentSchema } from "~/lib/chart/chart-adjustment";
import { marketSourceSchema } from "~/lib/market/market-source";
import type { MarketState } from "./use-market-state";

/** Mounted only on /market, inside Suspense so the shared shell stays prerenderable. */
export function MarketRouteSelection({
  enterMarket,
  frozen = false,
}: {
  enterMarket: MarketState["enterMarket"];
  /** A frozen candidate owns the chart; MarketPage restores it from the URL. */
  frozen?: boolean;
}) {
  const search = useSearchParams();
  const symbol = readChartSymbolParam(search.toString());
  const view = search.get("view") === "financial" ? "financial" : "chart";
  const period = chartPeriodSchema.safeParse(search.get("period")).data;
  const source = marketSourceSchema.safeParse(search.get("source")).data;
  const adjustment = chartAdjustmentSchema.safeParse(
    search.get("adjustment"),
  ).data;
  const base =
    search.get("base") === "5m"
      ? "5m"
      : search.has("period")
        ? "day"
        : undefined;
  const enter = useRef(enterMarket);
  enter.current = enterMarket;
  // Only navigation initiates a load. A pending response or local edit must not
  // replay an older URL while Next is committing the replacement search params.
  useEffect(() => {
    // A frozen candidate is accepted by MarketPage from its recorded snapshot;
    // reading this URL must not start a live load and replace that evidence.
    if (frozen) return;
    enter.current(symbol, view, {
      ...(period ? { chartPeriod: period } : {}),
      ...(source ? { marketSource: source } : {}),
      ...(adjustment ? { adjustment } : {}),
      ...(base ? { period: base } : {}),
    });
  }, [symbol, view, period, source, adjustment, base, frozen]);
  return null;
}
