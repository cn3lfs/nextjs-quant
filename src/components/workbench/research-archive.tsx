import { CanslimPanel } from "../research/canslim-panel";
import { ChanPanel } from "../research/chan-panel";
import { FinancialQualityPanel } from "../research/financial-quality-panel";
import { ValuationPanel } from "../research/valuation-panel";
import { WyckoffPanel } from "../research/wyckoff-panel";

import { ReportArchive } from "./reports";
import { type WorkbenchState } from "./use-workbench-state";

export function ResearchArchive({
  state,
}: {
  state: Pick<WorkbenchState, "symbol" | "loaded" | "names" | "activeJobs">;
}) {
  const { symbol, loaded, names, activeJobs } = state;
  return (
    <>
      <CanslimPanel archive />
      <ChanPanel archive />
      <WyckoffPanel archive />
      <ValuationPanel key={symbol} symbol={symbol} />
      <FinancialQualityPanel
        key={`financial-${symbol}`}
        symbol={symbol}
        snapshot={loaded ?? undefined}
      />
      <ReportArchive names={names} active={activeJobs.length > 0} />
    </>
  );
}
