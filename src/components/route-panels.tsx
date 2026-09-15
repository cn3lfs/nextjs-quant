"use client";
import { useState } from "react";
import { ClsReviewControls } from "./cls-review-controls";
import { ConceptRpsControls } from "./concept-rps-controls";
import { IndustryRpsControls } from "./industry-rps-controls";
import { IntradayControls } from "./intraday-controls";
import { ResearchUsageContainer } from "./research-usage-container";
import { RpsControls } from "./rps-controls";
import { RpsOverview } from "./rps-overview";
import { StrategyResearchControls } from "./strategy-research-controls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { PanelVisibility } from "./workbench/keep-alive";

/**
 * Bodies of the routed workbench tabs, shared by the route definitions under
 * `src/app` and by the workbench panel cache. The workbench keeps a visited panel
 * mounted so switching tabs does not discard drafts, pagination or scroll state.
 * Routes that fetch server data per request (signal ledger, trade ledger) stay on
 * the framework navigation and are deliberately absent here.
 */
export function IntradayPanel() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">午尾盘预选与收盘确认</h1>
      <IntradayControls />
    </main>
  );
}

const rpsTabs = [
  { value: "stock", label: "个股 RPS" },
  { value: "industry", label: "行业 RPS" },
  { value: "concept", label: "概念 RPS" },
] as const;

/**
 * RPS-only workbench page: 运行状态 and 历史日志 boxes on top, then one tab per
 * ranking population. Tab bodies stay mounted so pagination and drafts survive
 * switching, while `PanelVisibility` pauses the polling of hidden tabs.
 */
export function RpsPanel() {
  const [tab, setTab] = useState<(typeof rpsTabs)[number]["value"]>("stock");
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">RPS数据管理</h1>
        <p className="text-sm text-muted-foreground">
          个股、行业与概念的相对强度排名计算与审计。三者共用同一任务队列，同一时间只运行一个任务。
        </p>
        <nav className="flex flex-wrap gap-4 text-sm">
          <a className="text-primary underline" href="/intraday">
            午尾盘预选与收盘确认
          </a>
          <a className="text-primary underline" href="/research">
            策略样本研究
          </a>
        </nav>
      </header>
      <RpsOverview />
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as typeof tab)}
        className="gap-4"
      >
        <TabsList aria-label="RPS排名口径">
          {rpsTabs.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="stock" forceMount hidden={tab !== "stock"}>
          <PanelVisibility visible={tab === "stock"}>
            <RpsControls />
          </PanelVisibility>
        </TabsContent>
        <TabsContent value="industry" forceMount hidden={tab !== "industry"}>
          <PanelVisibility visible={tab === "industry"}>
            <IndustryRpsControls />
          </PanelVisibility>
        </TabsContent>
        <TabsContent value="concept" forceMount hidden={tab !== "concept"}>
          <PanelVisibility visible={tab === "concept"}>
            <ConceptRpsControls />
          </PanelVisibility>
        </TabsContent>
      </Tabs>
    </main>
  );
}

export function ResearchPanel() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">策略样本研究</h1>
      <ResearchUsageContainer />
      <StrategyResearchControls />
    </main>
  );
}

export function ClsReviewPanel() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">财联社观点复盘</h1>
      <ClsReviewControls />
    </main>
  );
}

export const routePanels = {
  "/intraday": IntradayPanel,
  "/rps": RpsPanel,
  "/research": ResearchPanel,
  "/cls-review": ClsReviewPanel,
} as const;
