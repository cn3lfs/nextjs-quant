import { useSyncExternalStore } from "react";

// Component harness only: Next publishes native history changes to its search
// params hook. The production E2E separately exercises the actual router.
for (const name of ["pushState", "replaceState"] as const) {
  const original = window.history[name].bind(window.history);
  window.history[name] = (data: unknown, unused: string, url?: string | URL | null) => {
    original(data, unused, url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
}
function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}
export function useSearchParams() {
  return new URLSearchParams(
    useSyncExternalStore(subscribe, () => window.location.search, () => ""),
  );
}
