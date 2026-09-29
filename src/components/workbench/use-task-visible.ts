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
export function useTaskVisible() {
  const panel = usePanelVisible();
  const focus = useSyncExternalStore(subscribe, focused, () => false);
  return panel && focus;
}
