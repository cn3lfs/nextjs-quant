import { createHash } from "node:crypto";
import type { Period, Snapshot } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartSnapshot } from "~/lib/chart/chart-snapshot";
import { cryptoAssets, cryptoDisplayName } from "~/lib/market/crypto";
import { binanceKlines } from "../data-sources/binance/binance-klines";

/**
 * Crypto charts bypass the A-share chain entirely: no vipdoc, adjustment,
 * trading-session gaps or exchange calendar. Binance serves every period
 * natively (UTC close), so nothing is aggregated or back-filled locally.
 */
const volumeUnit = (symbol: string) => {
  const { base, quote } = cryptoAssets(symbol);
  return `成交量单位 ${base || "基础币"}；成交额单位 ${quote || "计价币"}`;
};

export async function cryptoSnapshot(
  symbol: string,
  period: Period,
): Promise<Snapshot> {
  const result = await binanceKlines({ symbol, period, limit: 2000 });
  const hash = createHash("sha256")
    .update(JSON.stringify({ symbol, period, bars: result.bars }))
    .digest("hex");
  return {
    id: `snapshot-crypto-${hash}`,
    symbol,
    name: cryptoDisplayName(symbol),
    period,
    source: result.source,
    adjustment: "none",
    createdAt: Date.now(),
    bars: result.bars,
    hash,
    sourceUrl: result.sourceUrl,
    volumeUnit: volumeUnit(symbol),
    sourceNote: result.sourceNote,
    sourceErrors: result.sourceErrors,
    sourceVersions: [result.version],
  };
}

export async function cryptoChartSnapshot(
  source: Snapshot,
  period: ChartPeriod,
  limit: number,
): Promise<ChartSnapshot> {
  const result = await binanceKlines({ symbol: source.symbol, period, limit });
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        period,
        source: result.source,
        bars: result.bars,
        formingDates: result.formingDates,
      }),
    )
    .digest("hex");
  return {
    ...source,
    period,
    adjustment: "none",
    source: result.source,
    sourceUrl: result.sourceUrl,
    volumeUnit: volumeUnit(source.symbol),
    bars: result.bars,
    hash,
    createdAt: Date.now(),
    formingDates: result.formingDates,
    excluded: [],
    historyExhausted: result.historyExhausted,
    sourceNote: result.sourceNote,
    sourceErrors: result.sourceErrors,
    sourceVersions: [result.version],
    id: `chart-snapshot-${source.symbol}-${period}-${hash.slice(0, 20)}`,
  };
}
