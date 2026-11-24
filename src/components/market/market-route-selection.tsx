"use client";

import { useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { readChartSymbolParam } from "~/lib/chart/chart-symbol";
import { chartPeriodSchema } from "~/lib/chart/chart-view";
import { chartAdjustmentSchema } from "~/lib/chart/chart-adjustment";
import { marketSourceSchema } from "~/lib/market/market-source";
import { useMarketSession } from "~/lib/stores/market-session";
import { parseTradeReviewRef } from "~/lib/chart/chart-trade-marks";
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
  const query = search.toString();
  const symbol = readChartSymbolParam(query);
  const review = useMemo(() => parseTradeReviewRef(query), [query]);
  const view = search.get("view") === "financial" ? "financial" : "chart";
  const atParam = search.get("at");
  const at =
    atParam && /^\d{4}-\d{2}-\d{2}$/.test(atParam) ? atParam : undefined;
  const diagnose = search.get("diagnose") || undefined;
  const cell = search.get("cell") || undefined;
  const scenario = search.get("scenario") || undefined;
  const period =
    chartPeriodSchema.safeParse(search.get("period")).data ??
    (at || diagnose || review ? "day" : undefined);
  const source = marketSourceSchema.safeParse(search.get("source")).data;
  const adjustment =
    chartAdjustmentSchema.safeParse(search.get("adjustment")).data ??
    (review ? "none" : undefined);
  const base =
    search.get("base") === "5m"
      ? "5m"
      : period || search.has("period")
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
  useEffect(() => {
    const state = useMarketSession.getState();
    const target = symbol ?? state.symbol;
    const current = state.tradeContext;
    if (frozen || (!at && !diagnose && !review)) {
      // The toggle removes the URL context while retaining the fills locally.
      if (current && (frozen || current.visible || current.symbol !== target))
        state.clearTradeContext();
      return;
    }
    if (
      current &&
      current.symbol === target &&
      current.at === at &&
      current.diagnose === diagnose &&
      current.cell === cell &&
      current.scenario === scenario &&
      JSON.stringify(current.review ?? null) === JSON.stringify(review) &&
      current.visible
    )
      return;
    state.setChartMode("k");
    state.setTradeContext({
      symbol: target,
      at,
      diagnose,
      cell,
      scenario,
      review: review ?? undefined,
    });
  }, [symbol, at, diagnose, cell, scenario, review, frozen]);
  return null;
}
