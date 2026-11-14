"use client";

import { useState } from "react";
import { PanelVisibility } from "./keep-alive";
import { FinancialQualityPanel } from "../research/financial-quality-panel";
import { ValuationPanel } from "../research/valuation-panel";
import { LocalFinancialWorkbench } from "../financial/local-financial-workbench";

import { ArchiveList } from "./archive-list";
import { Scales } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel, Segmented } from "../panels";
import { useMarketSession } from "~/lib/stores/market-session";

export function ResearchArchive() {
  const symbol = useMarketSession((state) => state.symbol);
  const [workspace, setWorkspace] = useState<
    "archive" | "valuation" | "local" | "quality"
  >("archive");
  return (
    <PageGrid>
      <div className="nc-span-12">
        <Segmented
          label="研究档案工作区"
          value={workspace}
          onChange={setWorkspace}
          options={[
            { value: "archive", label: "报告档案" },
            { value: "valuation", label: "估值假设" },
            { value: "local", label: "本地财务" },
            { value: "quality", label: "在线财务质量" },
          ]}
        />
      </div>
      <PanelVisibility visible={workspace === "archive"}>
        <div className="nc-span-12" hidden={workspace !== "archive"}>
          <ArchiveList />
        </div>
      </PanelVisibility>
      <div className="nc-span-12" hidden={workspace === "archive"}>
        <Panel
          icon={Scales}
          title={
            workspace === "valuation"
              ? "估值假设"
              : workspace === "local"
                ? "本地财务研究"
                : "在线财务质量"
          }
          meta={symbol.toUpperCase()}
          bodyClassName="flex flex-col gap-[var(--nc-gap)]"
        >
          <PanelVisibility visible={workspace === "valuation"}>
            <div hidden={workspace !== "valuation"}>
              <ValuationPanel key={symbol} symbol={symbol} />
            </div>
          </PanelVisibility>
          <PanelVisibility visible={workspace === "local"}>
            <div hidden={workspace !== "local"}>
              <LocalFinancialWorkbench
                key={`local-financial-${symbol}`}
                symbol={symbol}
              />
            </div>
          </PanelVisibility>
          <PanelVisibility visible={workspace === "quality"}>
            <div hidden={workspace !== "quality"}>
              <p className="text-sm text-nc-text-3">
                同花顺在线财务质量与历史档案 · 与本地财务数据分别保存。
              </p>
              <FinancialQualityPanel
                key={`financial-${symbol}`}
                symbol={symbol}
              />
            </div>
          </PanelVisibility>
        </Panel>
      </div>
    </PageGrid>
  );
}
