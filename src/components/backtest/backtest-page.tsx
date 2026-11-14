"use client";
import { useMarketSession } from "~/lib/stores/market-session";
import { BacktestView } from "../workbench/backtest-view";

export function BacktestPage() {
  const loaded = useMarketSession((state) => state.loaded);
  return <BacktestView loaded={loaded} />;
}
