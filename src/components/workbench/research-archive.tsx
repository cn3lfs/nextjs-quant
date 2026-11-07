import { FinancialQualityPanel } from "../research/financial-quality-panel";
import { ValuationPanel } from "../research/valuation-panel";
import { LocalFinancialWorkbench } from "../financial/local-financial-workbench";

import { ArchiveList } from "./archive-list";
import { Scales } from "@phosphor-icons/react/ssr";
import { PageGrid, Panel } from "../panels";
import { type WorkbenchState } from "./use-workbench-state";

export function ResearchArchive({
  state,
}: {
  state: Pick<WorkbenchState, "symbol" | "loaded" | "names" | "activeJobs">;
}) {
  const { symbol, loaded, names } = state;
  return (
    <PageGrid>
      <ArchiveList names={names} />
      <Panel
        icon={Scales}
        title="估值与财务质量"
        meta={symbol.toUpperCase()}
        bodyClassName="flex flex-col gap-[var(--nc-gap)]"
      >
        <ValuationPanel key={symbol} symbol={symbol} />
        <LocalFinancialWorkbench
          key={`local-financial-${symbol}`}
          symbol={symbol}
        />
        <details>
          <summary className="cursor-pointer text-sm">
            同花顺在线财务质量与历史档案
          </summary>
          <FinancialQualityPanel
            key={`financial-${symbol}`}
            symbol={symbol}
            snapshot={loaded ?? undefined}
          />
        </details>
      </Panel>
    </PageGrid>
  );
}
