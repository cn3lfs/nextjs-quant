// App policies and display-name fallbacks; all local file handling is in tstdx.
import { scan as scanLocal } from "tstdx/local";
import type { Coverage } from "~/lib/domain";
import { exchangeNames } from "../../market/exchange-security-names";
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
export async function scan(root: string): Promise<Coverage> {
  const coverage = await scanLocal(root);
  return {
    ...coverage,
    securities: coverage.securities.map((row) => ({
      ...row,
      market: "cn-equity" as const,
      exchange: row.market,
      name:
        row.name === row.symbol
          ? (exchangeNames.get(row.symbol)?.name ?? row.name)
          : row.name,
    })),
  };
}
