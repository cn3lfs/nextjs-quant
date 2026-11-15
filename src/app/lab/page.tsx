import { StrategyLab } from "~/components/research/strategy-lab";
import { Suspense } from "react";

export default function StrategiesPage() {
  return (
    <>
      <Suspense fallback={<p role="status">正在读取实验室…</p>}>
        <StrategyLab />
      </Suspense>
    </>
  );
}
