"use client";
import { EvidenceAnalysis } from "~/components/workbench/evidence-analysis";
import { useWorkbenchNotify } from "~/components/workbench/workbench-notify";
import { useMarketSession } from "~/lib/stores/market-session";

export default function AnalysisPage() {
  const loaded = useMarketSession((state) => state.loaded);
  const notify = useWorkbenchNotify();
  return <EvidenceAnalysis loaded={loaded} notify={notify} />;
}
