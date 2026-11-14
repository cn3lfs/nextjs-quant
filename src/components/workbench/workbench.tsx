"use client";
import dynamic from "next/dynamic";
import { Activity, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { MarketRouteSelection } from "../market/market-route-selection";
import { routePanels } from "./route-panels";
import { Button } from "../ui/button";

import { navItemFor } from "./navigation";
import { PanelCache } from "./keep-alive";
import { WorkbenchSidebar } from "./workbench-sidebar";
import { Topbar } from "./topbar";
import { useWorkbenchState } from "./use-workbench-state";
import { OpenChartProvider } from "../market/open-chart";
import type { BrowseList } from "~/lib/market/browse-list";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";

// Panels load on first visit: the root layout would otherwise ship every
// page body in one client bundle.
const NewsPanel = dynamic(() =>
  import("../news/news-panel").then((m) => m.NewsPanel),
);
const SettingsPanel = dynamic(() =>
  import("./settings-panel").then((m) => m.SettingsPanel),
);
const BacktestView = dynamic(() =>
  import("./backtest-view").then((m) => m.BacktestView),
);
const EvidenceAnalysis = dynamic(() =>
  import("./evidence-analysis").then((m) => m.EvidenceAnalysis),
);
const MarketView = dynamic(() =>
  import("./market-view").then((m) => m.MarketView),
);
const ResearchArchive = dynamic(() =>
  import("./research-archive").then((m) => m.ResearchArchive),
);
const ScreenWorkspace = dynamic(() =>
  import("../screening/screen-workspace").then((m) => m.ScreenWorkspace),
);
const SignalsView = dynamic(() =>
  import("./signals-view").then((m) => m.SignalsView),
);

/**
 * Fetches the panel chunks once the first page is idle, so a first visit does
 * not wait on the network (~70-150 ms measured). Same import() paths as the
 * dynamic() calls above, so the bundler shares their chunks.
 */
function usePanelPrefetch() {
  useEffect(() => {
    // One chunk per idle period, the next only after it has loaded, so the
    // evaluation never blocks a click for long (loading all at once did).
    const queue = [
      () => import("../screening/screen-workspace"),
      () => import("./signals-view"),
      () => import("./backtest-view"),
      () => import("../news/news-panel"),
      () => import("./research-archive"),
      () => import("./evidence-analysis"),
      () => import("./settings-panel"),
      // market-view is left out: evaluating the chart library blocks the
      // main thread for hundreds of ms, and its own first visit is ~130 ms.
    ];
    let cancelled = false,
      handle = 0;
    const idle = (run: () => void) =>
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(run, { timeout: 5000 })
        : window.setTimeout(run, 300);
    const next = () => {
      const load = queue.shift();
      if (!load || cancelled) return;
      handle = idle(() => {
        if (!cancelled) void load().finally(next);
      });
    };
    next();
    return () => {
      cancelled = true;
      if (typeof window.cancelIdleCallback === "function")
        window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, []);
}

export function Workbench({ children }: { children?: ReactNode }) {
  usePanelPrefetch();
  const pathname = usePathname();
  const router = useRouter();
  const base = useWorkbenchState();
  const item = navItemFor(pathname);
  const state = base;
  const { toast, setToast, notify } = state;
  // Chart links in tables switch here without reloading the kept-alive panels.
  const openChart = (symbol: string, list?: BrowseList) => {
    const href = chartSymbolHref(symbol);
    if (href.startsWith("/market?")) {
      base.setBrowse(list ?? null);
      base.selectMarketSymbol(symbol);
    }
    router.push(href, { scroll: false });
  };
  const panels: Record<string, ReactNode> = {
    "/market": (
      <MarketView
        notify={notify}
        state={{
          marketSource: state.marketSource,
          marketView: state.marketView,
          setMarketView: state.setMarketView,
          setMarketSource: state.setMarketSource,
          symbol: state.symbol,
          setSymbol: state.setSymbol,
          period: state.period,
          loaded: state.loaded,
          load: state.load,
          browse: state.browse,
          setBrowse: state.setBrowse,
        }}
      />
    ),
    "/screen": (
      <ScreenWorkspace
        notify={notify}
        market={{
          setTab: state.setTab,
          setSymbol: state.setSymbol,
          setBrowse: state.setBrowse,
          setPeriod: state.setPeriod,
          load: state.load,
        }}
      />
    ),
    "/backtest": <BacktestView loaded={state.loaded} />,
    "/signals": <SignalsView />,
    "/reports": <ResearchArchive state={{ symbol: state.symbol }} />,
    "/analysis": <EvidenceAnalysis loaded={state.loaded} notify={notify} />,
    "/news": <NewsPanel />,
    "/settings": <SettingsPanel notify={notify} />,
    ...Object.fromEntries(
      Object.entries(routePanels).map(([href, Panel]) => [
        href,
        <Panel key={href} />,
      ]),
    ),
  };
  return (
    <div className="app-shell">
      {pathname === "/market" && (
        <Suspense fallback={null}>
          <MarketRouteSelection enterMarket={base.enterMarket} />
        </Suspense>
      )}
      <WorkbenchSidebar active={item?.href} />
      <main className="main">
        <Topbar
          crumb={item?.group ?? ""}
          title={item?.title ?? item?.label ?? ""}
          subtitle={item?.subtitle}
        />
        <div className="page">
          {/* Cached domain panels retain local UI until eviction. Ordinary
              routes own their content and explicit session state. */}
          <OpenChartProvider value={openChart}>
            <PanelCache active={pathname} panels={panels} />
            {/* Framework routes render their own content. */}
            {!(pathname in panels) && children}
          </OpenChartProvider>
        </div>
      </main>
      {toast && (
        <div role="status" className="toast">
          <Activity size={17} />
          {toast}
          <Button
            variant="plain"
            aria-label="关闭提示"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </Button>
        </div>
      )}
    </div>
  );
}
