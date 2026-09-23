import { createHash } from "node:crypto";
import { type Bar, type Period, type Snapshot } from "~/lib/domain";
import { type ChartPeriod } from "~/lib/chart/chart-view";
import { type MarketSource, marketSourceLabels } from "~/lib/market/market-source";
import { tstdxKlines } from "../data-sources/tstdx/tstdx-adapter";
import { onlinePeriodHistory } from "./chart-history";
import { westockKlines } from "../data-sources/westock/westock-adapter";

export { parseWestockBars as parseTencentChart } from "../data-sources/westock/westock-bars";
export type FreeChartHistoryResult = {
  bars: Bar[];
  source: string;
  volumeUnit?: string;
  historyExhausted: boolean;
  sourceNote?: string;
  sourceErrors?: string[];
};
export async function tencentChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
): Promise<FreeChartHistoryResult> {
  const result = await westockKlines({ symbols: [symbol], period, limit });
  const item = result.items[0]!;
  if (item.status !== "ok") throw new Error(item.message);
  return {
    bars: item.bars,
    source: "tencent/westock-data",
    volumeUnit: "源单位未独立核验",
    historyExhausted: true,
    sourceNote: `${result.version}；westock-data 延迟行情；最多2000根，成交量/额单位未独立核验；${result.warnings.join("；")}`,
  };
}

export async function pytdxChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
): Promise<FreeChartHistoryResult> {
  const result = await tstdxKlines({ symbols: [symbol], period, limit });
  const item = result.items[0]!;
  if (item.status !== "ok") throw new Error(item.message);
  return {
    bars: item.bars,
    source: result.source,
    volumeUnit: result.volumeUnit,
    historyExhausted: item.historyExhausted,
    sourceNote: `${result.version}；${result.warnings.join("；")}`,
  };
}
export type OnlineSource = Exclude<MarketSource, "local">;
export async function freeChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  source: OnlineSource = "auto",
): Promise<FreeChartHistoryResult> {
  const order =
    source === "auto" ? (["pytdx", "eastmoney", "tencent"] as const) : [source];
  const failures: string[] = [];
  for (const provider of order) {
    try {
      const result =
        provider === "pytdx"
          ? await pytdxChartHistory(symbol, period, limit)
          : provider === "tencent"
            ? await tencentChartHistory(symbol, period, limit)
            : await onlinePeriodHistory(symbol, period, limit);
      return {
        ...result,
        sourceNote: [
          ...failures,
          "sourceNote" in result ? result.sourceNote : "",
        ]
          .filter(Boolean)
          .join("；"),
        sourceErrors: failures,
      };
    } catch (error) {
      failures.push(
        `${marketSourceLabels[provider]}：${error instanceof Error ? error.message : "读取失败"}`,
      );
      if (source !== "auto") throw new Error(failures.join("；"));
    }
  }
  throw new Error(`所有免费在线源不可用：${failures.join("；")}`);
}
export async function freeChartSnapshot(
  symbol: string,
  period: Period,
  source: OnlineSource = "auto",
): Promise<Snapshot> {
  const result = await freeChartHistory(symbol, period, 2000, source);
  const hash = createHash("sha256")
    .update(JSON.stringify({ symbol, period, ...result }))
    .digest("hex");
  return {
    ...result,
    id: `snapshot-free-${hash}`,
    symbol,
    period,
    hash,
    adjustment: "none",
    createdAt: Date.now(),
    requestedSource: source,
  };
}
