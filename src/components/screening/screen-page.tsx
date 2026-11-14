"use client";
import { useRouter } from "next/navigation";
import { useMarketSession } from "~/lib/stores/market-session";
import { tabHref } from "../workbench/navigation";
import { useWorkbenchNotify } from "../workbench/workbench-notify";
import { ScreenWorkspace } from "./screen-workspace";

export function ScreenPage() {
  const router = useRouter();
  const notify = useWorkbenchNotify();
  // These are stable commands, not subscriptions to another domain's selection.
  const market = useMarketSession.getState();
  return (
    <ScreenWorkspace
      notify={notify}
      market={{
        setTab: (tab) =>
          router.push(
            tabHref(typeof tab === "function" ? tab("screen") : tab),
            { scroll: false },
          ),
        setSymbol: market.setSymbol,
        setPeriod: market.setPeriod,
        setBrowse: market.setBrowse,
        load: { acceptSnapshot: market.acceptSnapshot },
      }}
    />
  );
}
