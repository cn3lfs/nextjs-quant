import { createHash } from "node:crypto";
import type { Period, Snapshot } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartSnapshot } from "~/lib/chart/chart-snapshot";
import {
  cryptoAssets,
  cryptoDisplayName,
  cryptoSourceLabels,
  type CryptoSource,
  type CryptoVenue,
} from "~/lib/market/crypto";
import { binanceKlines } from "../data-sources/binance/binance-klines";
import { venueKlines } from "../data-sources/crypto-venues/venue-klines";
import { venues } from "../data-sources/crypto-venues/venues";

/**
 * Crypto charts bypass the A-share chain entirely: no vipdoc, adjustment,
 * trading-session gaps or exchange calendar. Every source serves its periods
 * natively (UTC close), so nothing is aggregated or back-filled locally.
 */
const volumeUnit = (symbol: string) => {
  const { base, quote } = cryptoAssets(symbol);
  return `成交量单位 ${base || "基础币"}；成交额单位 ${quote || "计价币"}`;
};

type Klines = Awaited<ReturnType<typeof venueKlines>>;
/** Fallback order for `auto`; each venue prices the same pair, never a
 *  substituted quote asset. */
const chain: CryptoVenue[] = ["binance", "okx", "gate", "coinbase", "bybit"];
const load = (
  venue: CryptoVenue,
  symbol: string,
  period: ChartPeriod,
  limit: number,
): Promise<Klines> =>
  venue === "binance"
    ? binanceKlines({ symbol, period, limit })
    : venueKlines(venues[venue], { symbol, period, limit });

const BACKOFF_MS = 5 * 60000;
const downUntil = new Map<CryptoVenue, { until: number; reason: string }>();

/** A manual pick runs only that source; `auto` walks the chain, skipping a
 *  recently failed source (never the last one) for five minutes. */
export async function cryptoKlines(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  pick: CryptoSource = "auto",
) {
  if (pick !== "auto") {
    const result = await load(pick, symbol, period, limit);
    return { ...result, sourceErrors: [] as string[] };
  }
  const errors: string[] = [];
  for (const [index, venue] of chain.entries()) {
    const name = cryptoSourceLabels[venue];
    const down = downUntil.get(venue);
    if (down && Date.now() < down.until && index < chain.length - 1) {
      errors.push(`${name}：近期不可用，已跳过（${down.reason}）`);
      continue;
    }
    try {
      const result = await load(venue, symbol, period, limit);
      downUntil.delete(venue);
      return {
        ...result,
        sourceNote: [result.sourceNote, ...errors].join("；"),
        sourceErrors: errors,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "读取失败";
      downUntil.set(venue, { until: Date.now() + BACKOFF_MS, reason: message });
      errors.push(`${name}：${message}`);
    }
  }
  throw new Error(`数字货币行情不可用：${errors.join("；")}`);
}

export async function cryptoSnapshot(
  symbol: string,
  period: Period,
  pick: CryptoSource = "auto",
): Promise<Snapshot> {
  const result = await cryptoKlines(symbol, period, 2000, pick);
  const hash = createHash("sha256")
    .update(JSON.stringify({ symbol, period, pick, bars: result.bars }))
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
    cryptoSource: pick,
  };
}

export async function cryptoChartSnapshot(
  source: Snapshot,
  period: ChartPeriod,
  limit: number,
): Promise<ChartSnapshot> {
  const result = await cryptoKlines(
    source.symbol,
    period,
    limit,
    source.cryptoSource,
  );
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
