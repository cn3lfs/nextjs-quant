import type { Bar, Settings } from "~/lib/domain";
import { ema } from "~/lib/indicators";
import { cryptoSymbol, isCryptoSymbol } from "~/lib/market/crypto";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";
import { readBars } from "../market/bar-store/read-bars";

type Adjustment = "forward" | "none";
type CandidateSymbol = { market: "cn-equity" | "crypto"; symbol: string };
type MetricsLoaders = {
  loadEquityBars?: (
    symbol: string,
    adjustment: Adjustment,
  ) => Promise<{
    bars: readonly Bar[];
    formingDates?: readonly string[];
  } | null>;
  loadCryptoBars?: (symbol: string) => Promise<{ bars: readonly Bar[] } | null>;
};

export type CandidateTechnicalMetrics = {
  currentPrice: number | null;
  ema5: number | null;
  ema20: number | null;
  asOfDate: string | null;
  priceBasis: "live" | "close" | null;
  adjustment: Adjustment | null;
  quoteTime: string | null;
};

export function computeCandidateMetricsFromBars(
  bars: readonly Bar[],
  adjustment: Adjustment,
): CandidateTechnicalMetrics {
  const latest = bars.at(-1);
  const validClose = (bar: Bar) => Number.isFinite(bar.close) && bar.close > 0;
  const currentPrice = latest && validClose(latest) ? latest.close : null;
  const observations = bars.reduce((n, bar) => n + Number(validClose(bar)), 0);
  const latestEma = (period: number) =>
    currentPrice !== null && observations >= period
      ? (ema(bars, period).at(-1) ?? null)
      : null;
  return {
    currentPrice,
    ema5: latestEma(5),
    ema20: latestEma(20),
    asOfDate: observations ? (latest?.date ?? null) : null,
    priceBasis: currentPrice === null ? null : "close",
    adjustment: observations ? adjustment : null,
    quoteTime: null,
  };
}

const candidateKey = ({ market, symbol }: CandidateSymbol) =>
  `${market}:${symbol}`;

export async function loadCandidateMarketMetrics(
  items: readonly CandidateSymbol[],
  config: Settings,
  now: number,
  deps: MetricsLoaders = {},
): Promise<Map<string, CandidateTechnicalMetrics | null>> {
  const loadEquity =
    deps.loadEquityBars ??
    (async (symbol, adjustment) => {
      const clock = chinaClock(now);
      // Anchor forward adjustment to the last completed session, including on replay.
      const to =
        clock.time < "15:00" ? chinaClock(now - 86400000).date : clock.date;
      const { bars, barStore } = await readBars({
        instrument: { market: "cn-equity", symbol },
        root: config.tdxRoot,
        period: "day",
        adjustment,
        source: "local",
        live: false,
        to,
        now,
      });
      return { bars, formingDates: barStore.formingDates };
    });
  const loadCrypto =
    deps.loadCryptoBars ??
    ((symbol) =>
      binanceArchiveSource({
        symbol: isCryptoSymbol(symbol) ? symbol : cryptoSymbol(symbol),
        configuredRoot: config.binancePublicDataRoot,
        period: "day",
        now,
      }));

  async function load({ market, symbol }: CandidateSymbol) {
    if (market === "crypto") {
      const snapshot = await loadCrypto(symbol);
      return snapshot?.bars.length
        ? computeCandidateMetricsFromBars(snapshot.bars, "none")
        : null;
    }

    for (const adjustment of ["forward", "none"] as const) {
      try {
        const snapshot = await loadEquity(symbol, adjustment);
        if (!snapshot?.bars.length) continue;
        const forming = new Set(snapshot.formingDates);
        const completed = forming.size
          ? snapshot.bars.filter((bar) => !forming.has(bar.date))
          : snapshot.bars;
        return completed.length
          ? computeCandidateMetricsFromBars(completed, adjustment)
          : null;
      } catch {
        // Missing local adjustment data can still leave usable raw bars.
      }
    }
    return null;
  }

  const unique = [...new Map(items.map((item) => [candidateKey(item), item]))];
  const metrics = new Map<string, CandidateTechnicalMetrics | null>();
  // Each forward read verifies the local GBBQ file. Bound simultaneous file buffers.
  const batchSize = 4;
  for (let start = 0; start < unique.length; start += batchSize) {
    await Promise.all(
      unique.slice(start, start + batchSize).map(async ([key, item]) => {
        try {
          metrics.set(key, await load(item));
        } catch {
          metrics.set(key, null);
        }
      }),
    );
  }
  return metrics;
}

export async function enrichCandidatePageWithMetrics<
  T extends CandidateSymbol & {
    marketMetrics: CandidateTechnicalMetrics | null;
  },
>(
  page: { total: number; items: T[] },
  config: Settings,
  now: number,
  deps?: Parameters<typeof loadCandidateMarketMetrics>[3],
): Promise<{ total: number; items: T[] }> {
  const metrics = await loadCandidateMarketMetrics(
    page.items,
    config,
    now,
    deps,
  );
  return {
    ...page,
    items: page.items.map((item) => ({
      ...item,
      marketMetrics: metrics.get(candidateKey(item)) ?? null,
    })),
  };
}
