"use client";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";

/** The only routes whose mounted chart/editor state survives navigation. */
export const retainedRoutes = {
  "/market": dynamic(() =>
    import("../market/market-page").then((m) => m.MarketPage),
  ),
  "/screen": dynamic(() =>
    import("../screening/screen-page").then((m) => m.ScreenPage),
  ),
  "/backtest": dynamic(() =>
    import("../backtest/backtest-page").then((m) => m.BacktestPage),
  ),
} as const;
export type RetainedRoute = keyof typeof retainedRoutes;

/** Route files declare real content through the same registry used by the cache. */
export function RetainedPage({ route }: { route: RetainedRoute }) {
  const Page = retainedRoutes[route];
  return (
    <div data-retained-route={route}>
      <Page />
    </div>
  );
}

export const retainedPanels: Record<string, ReactNode> = Object.fromEntries(
  Object.keys(retainedRoutes).map((route) => [
    route,
    <RetainedPage key={route} route={route as RetainedRoute} />,
  ]),
);
