"use client";
import { ClsReviewControls } from "./cls-review-controls";
import { ConceptRpsControls } from "./concept-rps-controls";
import { IndustryRpsControls } from "./industry-rps-controls";
import { IntradayControls } from "./intraday-controls";
import { ResearchUsageContainer } from "./research-usage-container";
import { RpsControls } from "./rps-controls";
import { StrategyResearchControls } from "./strategy-research-controls";

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

export function RpsPanel() {
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">个股RPS数据管理</h1>
      <a className="text-primary underline" href="/intraday">
        午尾盘预选与收盘确认
      </a>
      <a className="ml-4 text-primary underline" href="/research">
        策略样本研究
      </a>
      <RpsControls />
      <a className="text-primary underline" href="/cls-review">
        财联社观点复盘
      </a>
      <IndustryRpsControls />
      <ConceptRpsControls />
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
