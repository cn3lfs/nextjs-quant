import { commonIndices, isMarketIndex } from "~/lib/market/market-indices";
import { securityNames } from "../data-sources/tdx/tdx";
import type { Period, Security } from "~/lib/domain";

export async function indexDirectory(
  root: string,
  period: Period = "day",
): Promise<Security[]> {
  const names = new Map<string, string>(
    commonIndices.map((row) => [row.symbol, row.name]),
  );
  for (const market of ["sh", "sz"])
    for (const [symbol, name] of await securityNames(root, market))
      if (isMarketIndex(symbol)) names.set(symbol, name);
  return [...names].map(([symbol, name]) => ({
    symbol,
    name,
    market: symbol.slice(0, 2),
    period,
    bytes: 0,
    modified: 0,
  }));
}
