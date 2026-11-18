"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Snapshot } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartAdjustment } from "~/lib/chart/chart-adjustment";
import { PanelVisibility, usePanelVisible } from "../workbench/keep-alive";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ChartWorkspace } from "./chart-workspace";
import { TdxSnapshotContainer } from "./tdx-snapshot-container";
import { isTypingTarget } from "./chart-hotkeys";

type View = "chart" | "financial";
export function MarketSecurityViews({
  snapshot,
  period,
  adjustment,
  frozenEvidence = false,
  view,
  onViewChange,
  heading,
  actions,
}: {
  snapshot: Snapshot;
  period: ChartPeriod;
  adjustment: ChartAdjustment;
  /** Frozen candidate evidence: derive views only from the archived snapshot. */
  frozenEvidence?: boolean;
  view: View;
  onViewChange: (view: View) => void;
  heading?: ReactNode;
  actions?: ReactNode;
}) {
  const visible = usePanelVisible();
  const [visited, setVisited] = useState({
    chart: view === "chart",
    financial: view === "financial",
  });
  const [companyRequest, setCompanyRequest] = useState({
    symbol: "",
    sequence: 0,
  });
  useEffect(() => {
    setVisited((current) =>
      current[view] ? current : { ...current, [view]: true },
    );
  }, [view]);
  useEffect(() => {
    if (!visible || view !== "chart") return;
    const open = (event: KeyboardEvent) => {
      if (
        event.key !== "F10" ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        isTypingTarget(event.target)
      )
        return;
      event.preventDefault();
      setCompanyRequest((current) => ({
        symbol: snapshot.symbol,
        sequence: current.sequence + 1,
      }));
      onViewChange("financial");
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, [visible, view, snapshot.symbol, onViewChange]);
  return (
    <Tabs
      value={view}
      onValueChange={(value) => onViewChange(value as View)}
      className="min-w-0 gap-1"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2">
        {heading}
        <TabsList aria-label="证券详情视图">
          <TabsTrigger value="chart">行情图表</TabsTrigger>
          <TabsTrigger value="financial" title="F10 打开财务与公司资料">
            财务资料
          </TabsTrigger>
        </TabsList>
        {actions}
      </div>
      {(visited.chart || view === "chart") && (
        <TabsContent
          value="chart"
          forceMount
          className="min-w-0 data-[state=inactive]:hidden"
        >
          <PanelVisibility visible={view === "chart"}>
            <ChartWorkspace
              key={`${snapshot.id}:${period}:${adjustment}`}
              snapshot={snapshot}
              period={period}
              adjustment={adjustment}
              frozenEvidence={frozenEvidence}
            />
          </PanelVisibility>
        </TabsContent>
      )}
      {(visited.financial || view === "financial") && (
        <TabsContent
          value="financial"
          forceMount
          className="min-w-0 p-3 data-[state=inactive]:hidden"
        >
          <PanelVisibility visible={view === "financial"}>
            <TdxSnapshotContainer
              key={snapshot.symbol}
              symbol={snapshot.symbol}
              companyRequest={
                companyRequest.symbol === snapshot.symbol
                  ? companyRequest.sequence
                  : 0
              }
            />
          </PanelVisibility>
        </TabsContent>
      )}
    </Tabs>
  );
}
