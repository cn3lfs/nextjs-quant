"use client";
import dynamic from "next/dynamic";
import type { ReactNode } from "react";
import { WorkspaceTabs } from "./workspace-tabs";

/** The only routes whose mounted chart/editor state survives navigation. */
export const retainedRoutes = {
  "/scan": dynamic(() =>
    import("../screening/scan-workspace").then((m) => m.ScanWorkspace),
  ),
  "/lab/backtest": dynamic(() =>
    import("../backtest/backtest-page").then((m) => m.BacktestPage),
  ),
} as const;
export type RetainedRoute = keyof typeof retainedRoutes;

/** Route files declare real content through the same registry used by the cache. */
export function RetainedPage({ route }: { route: RetainedRoute }) {
  const Page = retainedRoutes[route];
  return (
    <div data-retained-route={route}>
      {route === "/lab/backtest" && <WorkspaceTabs workspace="/lab" />}
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
