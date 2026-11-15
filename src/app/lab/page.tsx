import { StrategyCenter } from "~/components/research/strategy-center";
import { PaperForwardStatus } from "~/components/portfolio/paper-forward-status";

export default function StrategiesPage() {
  return (
    <>
      <PaperForwardStatus />
      <StrategyCenter />
    </>
  );
}
