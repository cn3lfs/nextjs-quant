// App policies and display-name fallbacks; all local file handling is in tstdx.
import {
  readSnapshot as readLocalSnapshot,
  readTailSnapshot as readLocalTail,
  readHistoricalSnapshot as readLocalHistorical,
  scan as scanLocal,
} from "tstdx/local";
import type { Snapshot, Period, Coverage } from "~/lib/domain";
import { exchangeNames } from "../../market/exchange-security-names";
import { commonIndexName } from "~/lib/market/market-indices";
export {
  parseBars,
  parseNames,
  repairNote,
  securityNames,
  isAStock,
  isLocalFund,
  tailCacheStats,
  type ParseRepairs,
} from "tstdx/local";
function withName(snapshot: Snapshot): Snapshot {
  return {
    ...snapshot,
    name:
      snapshot.name ??
      exchangeNames.get(snapshot.symbol)?.name ??
      commonIndexName(snapshot.symbol),
  };
}
export async function scan(root: string): Promise<Coverage> {
  const coverage = await scanLocal(root);
  return {
    ...coverage,
    securities: coverage.securities.map((row) => ({
      ...row,
      name:
        row.name === row.symbol
          ? (exchangeNames.get(row.symbol)?.name ?? row.name)
          : row.name,
    })),
  };
}
export async function readSnapshot(
  root: string,
  symbol: string,
  period: Period,
  options: { chartFunds?: boolean } = {},
): Promise<Snapshot> {
  return withName(await readLocalSnapshot(root, symbol, period, options));
}
export async function readTailSnapshot(
  root: string,
  symbol: string,
  period: Period,
  count: number,
): Promise<Snapshot> {
  return withName(await readLocalTail(root, symbol, period, count));
}
export async function readHistoricalSnapshot(
  root: string,
  symbol: string,
  period: Period,
  count: number,
  asOf: string,
): Promise<Snapshot> {
  return withName(await readLocalHistorical(root, symbol, period, count, asOf));
}
