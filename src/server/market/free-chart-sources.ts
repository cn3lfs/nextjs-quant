import { createHash } from "node:crypto";
import { type Bar, type Period, type Snapshot } from "~/lib/domain";
import { type ChartPeriod } from "~/lib/chart/chart-view";
import {
  type MarketSource,
  type OnlineMarketSource,
  marketSourceLabels,
} from "~/lib/market/market-source";
import { tstdxKlines } from "../data-sources/tstdx/tstdx-adapter";
import { onlinePeriodHistory } from "./chart-history";
import { westockKlines } from "../data-sources/westock/westock-adapter";
import { thsdkKlines } from "../data-sources/thsdk/thsdk-adapter";
import { getThsdkStatus } from "../data-sources/thsdk/thsdk-auth";

export { parseWestockBars as parseTencentChart } from "../data-sources/westock/westock-bars";
export type FreeChartHistoryResult = {
  adjustment?: "none" | "qfq" | "hfq";
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
  if (period === "4h" || period === "1h") throw new Error("A股不支持该周期");
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
export async function thsdkChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  adjustment?: "none" | "qfq" | "hfq",
  end?: string,
): Promise<FreeChartHistoryResult> {
  if (period === "4h" || period === "1h") throw new Error("同花顺不支持该周期");
  const result = await thsdkKlines({
    symbols: [symbol],
    period,
    limit,
    ...(adjustment ? { adjustment } : {}),
    ...(end ? { end } : {}),
  });
  const item = result.items[0];
  if (!item) throw new Error("同花顺未返回行情");
  if (item.status !== "ok") throw new Error(item.message);
  return {
    bars: item.bars,
    source: result.source,
    volumeUnit: item.volumeUnit,
    historyExhausted: item.historyExhausted,
    adjustment: adjustment ?? "none",
    sourceNote: [result.version, "同花顺延迟行情", ...result.warnings].join(
      "；",
    ),
  };
}

function* providers(source: OnlineSource): Generator<OnlineMarketSource> {
  if (source !== "auto") {
    yield source;
    return;
  }
  yield "pytdx";
  yield "eastmoney";
  yield "tencent";
  // getThsdkStatus includes both flags from the same readThsdkConfig snapshot.
  const status = getThsdkStatus();
  if (
    status.enabled &&
    status.allowAutoFallback &&
    status.state === "authenticated"
  )
    yield "thsdk";
}

function providerHistory(
  provider: OnlineMarketSource,
  symbol: string,
  period: ChartPeriod,
  limit: number,
) {
  switch (provider) {
    case "pytdx":
      return pytdxChartHistory(symbol, period, limit);
    case "eastmoney":
      return onlinePeriodHistory(symbol, period, limit);
    case "tencent":
      return tencentChartHistory(symbol, period, limit);
    case "thsdk":
      return thsdkChartHistory(symbol, period, limit);
    default: {
      const unexpected: never = provider;
      throw new Error(`未知在线行情来源：${unexpected}`);
    }
  }
}

export async function freeChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  source: OnlineSource = "auto",
): Promise<FreeChartHistoryResult> {
  const failures: string[] = [];
  for (const provider of providers(source)) {
    try {
      const result = await providerHistory(provider, symbol, period, limit);
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
    market: "cn-equity",
    period,
    hash,
    adjustment: "none",
    createdAt: Date.now(),
    requestedSource: source,
  };
}
