"use client";
import { useState } from "react";
import { Ranking, TestTube } from "@phosphor-icons/react/ssr";
import { ClsReviewControls } from "../news/cls-review-controls";
import { ConceptRpsControls } from "../market/concept-rps-controls";
import { IndustryRpsControls } from "../market/industry-rps-controls";
import { IntradayControls } from "../intraday/intraday-controls";
import { ResearchUsageContainer } from "../research/research-usage-container";
import { RpsControls } from "../market/rps-controls";
import { RpsOverview } from "../market/rps-overview";
import { StrategyResearchControls } from "../research/strategy-research-controls";
import { PageGrid, Panel, Segmented } from "../panels";
import { PanelVisibility } from "./keep-alive";

/**
 * Bodies of the routed workbench pages, shared by the route definitions under
 * `src/app` and by the workbench panel cache. The workbench keeps a visited panel
 * mounted so switching pages does not discard drafts, pagination or scroll state.
 * Routes that fetch server data per request (signal ledger, trade ledger) stay on
 * the framework navigation and are deliberately absent here. Page titles live in
 * the workbench topbar (navigation.ts).
 */
export function IntradayPanel() {
  return <IntradayControls />;
}

const rpsTabs = [
  { value: "stock", label: "个股" },
  { value: "industry", label: "行业" },
  { value: "concept", label: "概念" },
] as const;

/**
 * RPS page: 运行状态 and 历史日志 panels on top, then one ranking panel whose
 * segmented control switches population. Bodies stay mounted so pagination and
 * drafts survive switching, while `PanelVisibility` pauses hidden polling.
 */
export function RpsPanel() {
  const [tab, setTab] = useState<(typeof rpsTabs)[number]["value"]>("stock");
  return (
    <PageGrid>
      <RpsOverview />
      <Panel
        icon={Ranking}
        title="排名"
        meta="三者共用同一任务队列，同一时间只运行一个任务"
        actions={
          <Segmented
            label="RPS排名口径"
            value={tab}
            onChange={setTab}
            options={rpsTabs}
          />
        }
        note="高 RPS 是候选过滤，不是买入指令。"
      >
        <div hidden={tab !== "stock"}>
          <PanelVisibility visible={tab === "stock"}>
            <RpsControls />
          </PanelVisibility>
        </div>
        <div hidden={tab !== "industry"}>
          <PanelVisibility visible={tab === "industry"}>
            <IndustryRpsControls />
          </PanelVisibility>
        </div>
        <div hidden={tab !== "concept"}>
          <PanelVisibility visible={tab === "concept"}>
            <ConceptRpsControls />
          </PanelVisibility>
        </div>
      </Panel>
    </PageGrid>
  );
}

export function ResearchPanel() {
  return (
    <PageGrid>
      <ResearchUsageContainer />
      <Panel icon={TestTube} title="策略样本研究">
        <StrategyResearchControls />
      </Panel>
    </PageGrid>
  );
}

export function ClsReviewPanel() {
  return <ClsReviewControls />;
}

export const routePanels = {
  "/intraday": IntradayPanel,
  "/rps": RpsPanel,
  "/research": ResearchPanel,
  "/cls-review": ClsReviewPanel,
} as const;
