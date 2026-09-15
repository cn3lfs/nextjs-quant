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

/**
 * Panel cache for the workbench tabs: a panel mounts the first time it is shown,
 * then stays mounted behind `hidden` so switching tabs never rebuilds it.
 * Panels are re-created from current props on every render, so a cached panel
 * still receives fresh state while keeping the state of its own components.
 */
export function PanelCache({
  active,
  panels,
}: {
  active: string;
  panels: Record<string, ReactNode>;
}) {
  const [mounted, setMounted] = useState<string[]>([active]);
  if (!mounted.includes(active)) setMounted(nextMounted(mounted, active));
  return <>{mounted.map((key) => slot(key, active, panels[key] ?? null))}</>;
}
