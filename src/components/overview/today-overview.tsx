"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import type { WorkbenchState } from "../workbench/use-workbench-state";
import { Empty } from "../workbench/shared";

/** Deep links written before 行情图表 had its own route. */
export function useLegacyMarketLink() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("symbol") || params.has("poolCategory"))
      router.replace(`/market${window.location.search}`, { scroll: false });
  }, []);
}

export function TodayOverview(_: { state: WorkbenchState }) {
  useLegacyMarketLink();
  return <Empty>今日总览正在接入。</Empty>;
}
