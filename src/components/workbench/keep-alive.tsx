"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

/** False inside a cached panel that is currently hidden. */
const PanelVisible = createContext(true);

/**
 * Whether this panel is on screen. Cached panels keep their charts, tables and
 * scroll position while hidden; polling should pause by reading this flag.
 */
export function usePanelVisible() {
  return useContext(PanelVisible);
}

/**
 * Nested visibility, for tabs inside a panel: hidden tab content stays mounted
 * (state survives) while its queries pause, the same contract panels already use.
 */
export function PanelVisibility({
  visible,
  children,
}: {
  visible: boolean;
  children: ReactNode;
}) {
  const parent = usePanelVisible();
  return (
    <PanelVisible.Provider value={parent && visible}>
      {children}
    </PanelVisible.Provider>
  );
}

function slot(key: string, active: string, node: ReactNode) {
  return (
    <PanelVisible.Provider key={key} value={key === active}>
      <div hidden={key !== active}>{node}</div>
    </PanelVisible.Provider>
  );
}

/** Mounted keys in visit order; the active panel is appended on first show. */
export function nextMounted(mounted: string[], active: string): string[] {
  return mounted.includes(active) ? mounted : [...mounted, active];
}

/** Most panels kept mounted at once (decisions 2026-09-30). */
export const panelCacheLimit = 6;
/** Always kept: rebuilding the chart workspace is the most expensive. */
export const pinnedPanels: readonly string[] = ["/market"];
export type PanelCacheState = {
  /** Render order (stable, so kept panels never move in the DOM). */
  mounted: string[];
  /** Least recently shown first. */
  recent: string[];
};
/**
 * Shows `active` and evicts the least recently shown panels beyond `limit`,
 * never a pinned one or the active one. Returns the same object when nothing
 * changes so rendering can compare by identity.
 */
export function nextPanelCache(
  cache: PanelCacheState,
  active: string,
  limit = panelCacheLimit,
  pinned: readonly string[] = pinnedPanels,
): PanelCacheState {
  if (cache.recent.at(-1) === active && cache.mounted.includes(active))
    return cache;
  let mounted = nextMounted(cache.mounted, active);
  let recent = [...cache.recent.filter((key) => key !== active), active];
  for (const key of [...recent]) {
    if (mounted.length <= limit) break;
    if (key === active || pinned.includes(key)) continue;
    mounted = mounted.filter((k) => k !== key);
    recent = recent.filter((k) => k !== key);
  }
  return { mounted, recent };
}

/**
 * Panel cache for the workbench tabs: a panel mounts the first time it is shown,
 * then stays mounted behind `hidden` so switching tabs never rebuilds it — up
 * to `panelCacheLimit` panels; the least recently shown beyond that unmount
 * (their server data stays in the query cache). Panels are re-created from
 * current props on every render, so a cached panel still receives fresh state
 * while keeping the state of its own components.
 */
export function PanelCache({
  active,
  panels,
}: {
  active: string;
  panels: Record<string, ReactNode>;
}) {
  const [cache, setCache] = useState<PanelCacheState>({
    mounted: [active],
    recent: [active],
  });
  const next = nextPanelCache(cache, active);
  if (next !== cache) setCache(next);
  return (
    <>{next.mounted.map((key) => slot(key, active, panels[key] ?? null))}</>
  );
}
