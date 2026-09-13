import { StrategyResearchControls } from "~/components/strategy-research-controls";
import { ResearchUsageContainer } from "~/components/research-usage-container";

export default function ResearchPage() {
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">策略样本研究</h1>
      <ResearchUsageContainer />
      <StrategyResearchControls />
    </main>
  );
}
