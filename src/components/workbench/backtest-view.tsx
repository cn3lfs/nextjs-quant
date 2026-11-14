import type { Snapshot } from "~/lib/domain";
import { MaBaselinePanel } from "../backtest/ma-baseline-panel";

export function BacktestView({ loaded }: { loaded: Snapshot | null }) {
  return <MaBaselinePanel loaded={loaded} />;
}
