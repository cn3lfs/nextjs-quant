"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Segmented } from "~/components/panels";
import { AlphaLabWorkspace } from "~/components/research/alpha/alpha-lab-workspace";
import { EvidenceAnalysis } from "~/components/workbench/evidence-analysis";
import { PanelCache } from "~/components/workbench/keep-alive";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";
import { useMarketSession } from "~/lib/stores/market-session";

const tabs = [
  { value: "alpha", label: "多因子 Alpha 实验室" },
  { value: "evidence", label: "证据解读" },
] as const;

function AnalysisTabs() {
  const search = useSearchParams();
  const tab = search.get("tab") === "evidence" ? "evidence" : "alpha";
  const loaded = useMarketSession((state) => state.loaded);
  const notify = useWorkbenchNotify();

  return (
    <div className="space-y-[var(--nc-gap)]">
      <Segmented
        options={tabs}
        value={tab}
        label="研究分析"
        onChange={(next) => {
          if (next === tab) return;
          const url = new URL(window.location.href);
          url.searchParams.set("tab", next);
          window.history.pushState(null, "", url);
        }}
      />
      <PanelCache
        active={tab}
        panels={{
          alpha: <AlphaLabWorkspace />,
          evidence: <EvidenceAnalysis loaded={loaded} notify={notify} />,
        }}
      />
    </div>
  );
}

export default function AnalysisPage() {
  return (
    <Suspense fallback={<p role="status">正在加载研究分析…</p>}>
      <AnalysisTabs />
    </Suspense>
  );
}
