import { CanslimPanel } from "../research/canslim-panel";
import { ChanPanel } from "../research/chan-panel";
import { FinancialQualityPanel } from "../research/financial-quality-panel";
import { ValuationPanel } from "../research/valuation-panel";
import { WyckoffPanel } from "../research/wyckoff-panel";

import { ReportArchive } from "./reports";
import { Scales, Stack } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel } from "../panels";
import { type WorkbenchState } from "./use-workbench-state";

export function ResearchArchive({
  state,
}: {
  state: Pick<WorkbenchState, "symbol" | "loaded" | "names" | "activeJobs">;
}) {
  const { symbol, loaded, names, activeJobs } = state;
  return (
    <PageGrid>
      <ReportArchive names={names} active={activeJobs.length > 0} />
      <Panel
        icon={Stack}
        title="方法档案"
        meta="CAN SLIM · 缠论 · 威科夫"
        bodyClassName="flex flex-col gap-[var(--nc-gap)]"
      >
        <CanslimPanel archive />
        <ChanPanel archive />
        <WyckoffPanel archive />
      </Panel>
      <Panel
        icon={Scales}
        title="估值与财务质量"
        meta={symbol.toUpperCase()}
        bodyClassName="flex flex-col gap-[var(--nc-gap)]"
      >
        <ValuationPanel key={symbol} symbol={symbol} />
        <FinancialQualityPanel
          key={`financial-${symbol}`}
          symbol={symbol}
          snapshot={loaded ?? undefined}
        />
      </Panel>
    </PageGrid>
  );
}
