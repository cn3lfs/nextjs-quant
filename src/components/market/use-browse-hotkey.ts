"use client";

import { useEffect, useRef } from "react";
import { stepBrowse, type BrowseList } from "~/lib/market/browse-list";
import { usePanelVisible } from "../workbench/keep-alive";
import { isTypingTarget } from "./chart-hotkeys";

/**
 * PageUp/PageDown switch to the previous/next security of the list the chart
 * was opened from (TDX). Registered in the capture phase so it wins over the
 * chart's own PageUp/PageDown paging, which still applies when no list is set.
 */
export function useBrowseHotkey(
  browse: BrowseList | null,
  onStep: (next: BrowseList) => void,
  onEdge: (first: boolean) => void,
  disabled = false,
) {
  const visible = usePanelVisible();
  const latest = useRef({ browse, onStep, onEdge, disabled });
  latest.current = { browse, onStep, onEdge, disabled };
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      const { browse, onStep, onEdge, disabled } = latest.current;
      if (
        !browse ||
        (event.key !== "PageUp" && event.key !== "PageDown") ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      if (disabled) return;
      const next = stepBrowse(browse, event.key === "PageUp" ? -1 : 1);
      if (next) onStep(next);
      else onEdge(event.key === "PageUp");
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [visible]);
}
