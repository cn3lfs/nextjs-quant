"use client";

import { Suspense } from "react";
import { useRouter } from "next/navigation";
import { ScreenView } from "../workbench/screen-view";
import { usePanelVisible } from "../workbench/keep-alive";
import type { WorkbenchState } from "../workbench/use-workbench-state";
import type { MarketState } from "../market/use-market-state";
import { ScreenRouteSelection } from "./screen-route-selection";
import { useScreenResults } from "./use-screen-results";
import { useSecurityNames } from "../market/use-security-names";

export type ScreenWorkspaceProps = {
  market: Pick<MarketState, "setSymbol" | "setBrowse" | "setPeriod"> &
    Pick<WorkbenchState, "setTab"> & {
      load: Pick<MarketState["load"], "acceptSnapshot">;
    };
} & Pick<WorkbenchState, "notify">;
export type ScreenViewState = ReturnType<typeof useScreenResults> &
  ScreenWorkspaceProps["market"] & {
    names: Record<string, string>;
    selectFormulaJob: (id: string) => void;
  };

export function ScreenWorkspace({ market, notify }: ScreenWorkspaceProps) {
  const visible = usePanelVisible();
  const names = useSecurityNames().data ?? {};
  const router = useRouter();
  const results = useScreenResults(notify);
  return (
    <>
      {visible && (
        <Suspense fallback={null}>
          <ScreenRouteSelection selectJob={results.selectJob} />
        </Suspense>
      )}
      <ScreenView
        state={{
          ...market,
          ...results,
          names,
          selectFormulaJob: (id) => {
            results.selectJob(id);
            router.push(`/screen?job=${encodeURIComponent(id)}`, {
              scroll: false,
            });
          },
        }}
      />
    </>
  );
}
