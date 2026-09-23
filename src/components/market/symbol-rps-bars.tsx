"use client";
import { Ranking } from "@phosphor-icons/react/ssr";
import { isSectorChartSymbol } from "~/lib/chart/chart-symbol";
import { api } from "~/trpc/react";
import { BarsPanel } from "../panels";

/**
 * Latest 个股 RPS of one security across the stored periods. Shares the query
 * key with the chart workspace, so it adds no extra request.
 */
export function SymbolRpsBars({ symbol }: { symbol: string }) {
  const sector = isSectorChartSymbol(symbol);
  const curve = api.rpsCurve.useQuery(symbol, {
    enabled: !sector,
    retry: false,
    refetchOnWindowFocus: true,
  });
  const latest = [...(curve.data ?? [])]
    .reverse()
    .find((day) => day.values.some((value) => value));
  return (
    <BarsPanel
      span={4}
      icon={Ranking}
      title="RPS"
      meta={latest ? `个股 · 截至 ${latest.date.slice(5)}` : "个股"}
      empty={
        sector
          ? "板块行情不计算个股 RPS"
          : curve.isLoading
            ? "正在读取 RPS…"
            : curve.error
              ? `RPS 读取失败：${curve.error.message}`
              : "该证券尚无 RPS 结果"
      }
      items={
        latest
          ? latest.periods.flatMap((period, index) => {
              const value = latest.values[index];
              return value
                ? [
                    {
                      key: String(period),
                      name: `RPS ${period}`,
                      value: value.rps.toFixed(0),
                      pct: value.rps,
                    },
                  ]
                : [];
            })
          : []
      }
      note="高 RPS 是候选过滤，不是买入指令。"
    />
  );
}
