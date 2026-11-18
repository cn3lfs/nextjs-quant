import type { Period, Snapshot } from "~/lib/domain";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import type { ChartSnapshot } from "~/lib/chart/chart-snapshot";
import { cryptoAssets, type CryptoSource } from "~/lib/market/crypto";
import { readBars } from "./bar-store/read-bars";
const volumeUnit = (symbol: string) => {
  const { base, quote } = cryptoAssets(symbol);
  return `成交量单位 ${base || "基础币"}；成交额单位 ${quote || "计价币"}`;
};

export async function cryptoSnapshot(
  symbol: string,
  period: Period,
  pick: CryptoSource = "auto",
): Promise<Snapshot> {
  const result = await readBars({
    instrument: { market: "crypto", symbol },
    period,
    adjustment: "none",
    cryptoSource: pick,
    limit: 2000,
    live: true,
  });
  return { ...result, period, volumeUnit: volumeUnit(symbol) };
}
export async function cryptoChartSnapshot(
  source: Snapshot,
  period: ChartPeriod,
  limit: number,
): Promise<ChartSnapshot> {
  const result = await readBars({
    instrument: { market: "crypto", symbol: source.symbol },
    period,
    adjustment: "none",
    cryptoSource: source.cryptoSource,
    limit,
    live: true,
  });
  return {
    ...result,
    // Annotation RPCs identify the exact displayed chart separately from its
    // base snapshot, even when both reads currently contain identical bars.
    id: `chart-snapshot-${source.symbol}-${period}-${result.hash.slice(0, 20)}`,
    volumeUnit: volumeUnit(source.symbol),
    formingDates: result.barStore.formingDates,
    excluded: result.barStore.excluded,
    historyExhausted: result.barStore.coverage.historyExhausted,
  };
}
