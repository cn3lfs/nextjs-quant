import { usePathname, useRouter } from "next/navigation";
import { useMarketState } from "../market/use-market-state";
import { useState, type SetStateAction } from "react";
import { api } from "~/trpc/react";
import { navItemFor, tabHref, type Tab } from "./navigation";
import { useTaskVisible } from "./use-task-visible";
// Shared shell state. Domain panels own their queries and drafts;
// chart selection only loads a snapshot on explicit selection or the market route.
export function useWorkbenchState() {
  const pathname = usePathname();
  const router = useRouter();
  const tab = navItemFor(pathname)?.tab ?? "market";
  const setTab = (next: SetStateAction<Tab>) =>
    router.push(tabHref(typeof next === "function" ? next(tab) : next), {
      scroll: false,
    });
  const [toast, setToast] = useState("");
  const visible = useTaskVisible();
  // Only the chart's default source is shared here. Coverage, watchlists and
  // other settings belong to their visible consumers and must not render the shell.
  const source = api.status.useQuery(undefined, {
    enabled: visible && pathname === "/market",
    select: (value) => value.settings.marketDataSource,
  });
  const notify = (text: string) => {
    setToast(text);
    setTimeout(() => setToast(""), 7000);
  };
  const market = useMarketState(source.data);

  return {
    ...market,
    setTab,
    notify,
    tab,
    toast,
    setToast,
  };
}
export type WorkbenchState = ReturnType<typeof useWorkbenchState>;
