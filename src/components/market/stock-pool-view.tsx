"use client";
import { useRouter, useSearchParams } from "next/navigation";
import type { SetStateAction } from "react";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import {
  readMarketPoolLocation,
  marketPoolLocationHref,
  type MarketPoolLocation,
} from "~/lib/market/market-pool-location";
import { useOpenChart } from "./open-chart";
import { MarketPoolBrowser } from "./market-pool-browser";

function updateLocation(action: SetStateAction<MarketPoolLocation>) {
  const current = readMarketPoolLocation(window.location.search);
  const next = typeof action === "function" ? action(current) : action;
  if (next !== current)
    window.history.replaceState(null, "", marketPoolLocationHref(next));
}

export function StockPoolView() {
  const search = useSearchParams();
  const router = useRouter();
  const openChart = useOpenChart();
  const location = readMarketPoolLocation(search.toString());
  return (
    <MarketPoolBrowser
      location={location}
      onLocationChange={updateLocation}
      onSelect={(symbol) => {
        updateLocation((current) => ({
          ...current,
          query: { ...current.query, selected: symbol },
        }));
        if (openChart) openChart(symbol);
        else router.push(chartSymbolHref(symbol));
      }}
    />
  );
}
