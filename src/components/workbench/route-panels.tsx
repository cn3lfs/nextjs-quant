"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Ranking, TestTube } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Segmented } from "../panels";
import { PanelVisibility } from "./keep-alive";

// Panels load on first visit: the root layout would otherwise ship every
// page body in one client bundle.
const ClsReviewControls = dynamic(() =>
  import("../news/cls-review-controls").then((m) => m.ClsReviewControls),
);
const ConceptRpsControls = dynamic(() =>
  import("../market/concept-rps-controls").then((m) => m.ConceptRpsControls),
);
const IndustryRpsControls = dynamic(() =>
  import("../market/industry-rps-controls").then((m) => m.IndustryRpsControls),
);
const IntradayControls = dynamic(() =>
  import("../intraday/intraday-controls").then((m) => m.IntradayControls),
);
const ResearchUsageContainer = dynamic(() =>
  import("../research/research-usage-container").then(
    (m) => m.ResearchUsageContainer,
  ),
);
const RpsControls = dynamic(() =>
  import("../market/rps-controls").then((m) => m.RpsControls),
);
const RpsOverview = dynamic(() =>
  import("../market/rps-overview").then((m) => m.RpsOverview),
);
const StrategyResearchControls = dynamic(() =>
  import("../research/strategy-research-controls").then(
    (m) => m.StrategyResearchControls,
  ),
);
const CryptoView = dynamic(() =>
  import("../market/crypto-view").then((m) => m.CryptoView),
);
const FuturesView = dynamic(() =>
  import("../market/futures-view").then((m) => m.FuturesView),
);
const LimitUpView = dynamic(() =>
  import("../market/limit-up-view").then((m) => m.LimitUpView),
);

/**
 * Bodies of the routed workbench pages, shared by the route definitions under
 * `src/app` and by the workbench panel cache. The workbench keeps a visited panel
 * mounted so switching pages does not discard drafts, pagination or scroll state.
 * Ledger routes own their query/navigation state and stay on framework
 * navigation rather than this panel cache. Page titles live in
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
  "/crypto": CryptoView,
  "/futures": FuturesView,
  "/limit-up": LimitUpView,
} as const;
