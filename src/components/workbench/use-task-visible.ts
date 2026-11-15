"use client";
import { useSyncExternalStore } from "react";
import { usePanelVisible } from "./keep-alive";
function subscribe(listener: () => void) {
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}
const focused = () =>
  document.visibilityState === "visible" && document.hasFocus();
const shown = () => document.visibilityState === "visible";
/** Background activity: pauses when the panel is hidden or the window loses focus. */
export function useTaskVisible() {
  const panel = usePanelVisible();
  const focus = useSyncExternalStore(subscribe, focused, () => false);
  return panel && focus;
}
/**
 * Trading-critical panels: keep loading while on screen, even when the user is
 * focused on a broker or charting window beside the app.
 */
export function useScreenVisible() {
  const panel = usePanelVisible();
  const visible = useSyncExternalStore(subscribe, shown, () => false);
  return panel && visible;
}
