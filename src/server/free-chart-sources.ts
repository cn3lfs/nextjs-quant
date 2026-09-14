import { createHash } from "node:crypto";
import {
  symbolSchema,
  type Bar,
  type Period,
  type Snapshot,
} from "~/lib/domain";
import { type ChartPeriod } from "~/lib/chart-view";
import { type MarketSource, marketSourceLabels } from "~/lib/market-source";
import { isMarketIndex } from "~/lib/market-indices";
import { barPage, indexBarPage } from "./tdx-quotes";
import { onlinePeriodHistory } from "./chart-history";
import { westockKlines } from "./westock-adapter";

export { parseWestockBars as parseTencentChart } from "./westock-bars";
export async function tencentChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
) {
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
) {
  symbolSchema.parse(symbol);
  const read = isMarketIndex(symbol) ? indexBarPage : barPage;
  const collected = new Map<string, Bar>();
  let historyExhausted = false;
  for (let offset = 0; offset < limit; offset += 800) {
    const count = Math.min(800, limit - offset);
    const page = await read(symbol, period, offset, count);
    const size = collected.size;
    for (const bar of page) {
      const previous = collected.get(bar.date);
      if (previous && JSON.stringify(previous) !== JSON.stringify(bar))
        throw new Error("tstdx 分页重叠行情发生变化，请刷新");
      collected.set(bar.date, bar);
    }
    if (page.length < count || collected.size === size) {
      historyExhausted = true;
      break;
    }
  }
  if (!collected.size) throw new Error("tstdx 未返回行情");
  return {
    bars: [...collected.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit),
    source: "tdx-7709",
    volumeUnit: "源单位",
    historyExhausted,
  };
}
export type OnlineSource = Exclude<MarketSource, "local">;
export async function freeChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  source: OnlineSource = "auto",
) {
  const order =
    source === "auto" ? (["eastmoney", "tencent", "pytdx"] as const) : [source];
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
