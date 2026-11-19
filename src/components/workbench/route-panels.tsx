"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Ranking } from "@phosphor-icons/react/ssr";
import {
  MethodologyPopover,
  PageGrid,
  Panel,
  Segmented,
} from "../panels";
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
const RpsControls = dynamic(() =>
  import("../market/rps-controls").then((m) => m.RpsControls),
);
const RpsOverview = dynamic(() =>
  import("../market/rps-overview").then((m) => m.RpsOverview),
);

/**
 * Bodies owned by ordinary Next routes. Only the RPS page's internal tabs
 * remain mounted; leaving the route unmounts the entire page.
 */
export function IntradayPanel() {
  return <IntradayControls />;
}

const rpsTabs = [
  { value: "stock", label: "个股" },
  { value: "industry", label: "行业" },
  { value: "concept", label: "概念" },
] as const;

const rpsMethodology = [
  {
    label: "任务队列",
    detail: "个股、行业、概念共用同一任务队列，同一时间只运行一个任务。",
  },
  {
    label: "用途",
    detail: "高 RPS 是候选过滤，不是买入指令。",
  },
  {
    label: "排名口径",
    detail:
      "RPS 为全市场排名分位（0–100）；条件过滤不重新排名，分母始终是全市场。回填批次存在生存者偏差。",
  },
  {
    label: "基准日",
    detail: "始终展示最近一个已完成结果日；历史日期的排名请到行情图表页按证券查看 RPS 曲线。",
  },
];

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
        actions={
          <div className="flex items-center gap-2">
            <Segmented
              label="RPS排名口径"
              value={tab}
              onChange={setTab}
              options={rpsTabs}
            />
            <MethodologyPopover title="RPS 排名口径" items={rpsMethodology} />
          </div>
        }
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

export function ClsReviewPanel() {
  return <ClsReviewControls />;
}
