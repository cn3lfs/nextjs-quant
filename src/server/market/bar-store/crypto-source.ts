import type { ChartPeriod } from "~/lib/chart/chart-view";
import {
  cryptoSourceLabels,
  type CryptoSource,
  type CryptoVenue,
} from "~/lib/market/crypto";
import { binanceKlines } from "../../data-sources/binance/binance-klines";
import { venueKlines } from "../../data-sources/crypto-venues/venue-klines";
import { venues } from "../../data-sources/crypto-venues/venues";
type Klines = Awaited<ReturnType<typeof venueKlines>>;
/** Fallback order for `auto`; each venue prices the same pair, never a
 *  substituted quote asset. */
const chain: CryptoVenue[] = ["binance", "okx", "gate", "coinbase", "bybit"];
const load = (
  venue: CryptoVenue,
  symbol: string,
  period: ChartPeriod,
  limit: number,
  before?: number,
): Promise<Klines> =>
  venue === "binance"
    ? binanceKlines({
        symbol,
        period,
        limit,
        ...(before !== undefined ? { before } : {}),
      })
    : venueKlines(venues[venue], {
        symbol,
        period,
        limit,
        ...(before !== undefined ? { before } : {}),
      });

const BACKOFF_MS = 5 * 60000;
const downUntil = new Map<CryptoVenue, { until: number; reason: string }>();

/** A manual pick runs only that source; `auto` walks the chain, skipping a
 *  recently failed source (never the last one) for five minutes. */
export async function cryptoKlines(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  pick: CryptoSource = "auto",
  before?: number,
) {
  if (pick !== "auto") {
    const result = await load(pick, symbol, period, limit, before);
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
      const result = await load(venue, symbol, period, limit, before);
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
