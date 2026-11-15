"use client";
import { Suspense } from "react";
import { useMarketSession } from "~/lib/stores/market-session";
import { BacktestView } from "../workbench/backtest-view";
import { LabBacktest } from "../research/lab-backtest";

export function BacktestPage() {
  const loaded = useMarketSession((state) => state.loaded);
  return (
    <>
      <Suspense fallback={<p role="status">正在读取策略对象…</p>}>
        <LabBacktest />
      </Suspense>
      <BacktestView loaded={loaded} />
    </>
  );
}
