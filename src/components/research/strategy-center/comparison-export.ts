import { formatNumber } from "trading-strategy-core/format-number";

export function formatPercent(value: number | null) {
  return value === null ? "—" : `${formatNumber(value * 100, 2)}%`;
}
/** Only the confirmed comparison response is exported; drafts and extra fields stay out. */
export function comparisonExportDocument<
  T extends {
    id: string;
    strategyId: string;
    comparisonBasis: unknown;
    overview: unknown;
  },
>(data: readonly T[]) {
  return {
    format: "strategy-center-comparison-1",
    basis: data[0]?.comparisonBasis ?? null,
    items: data.map(({ id, strategyId, overview }) => ({
      id,
      strategyId,
      overview,
    })),
  };
}
export function comparisonScope(basis: {
  symbol: string | null;
  poolCount: number | null;
}) {
  if (basis.symbol !== null && basis.poolCount !== null)
    return `${basis.symbol} · 证券池 ${basis.poolCount} 只`;
  if (basis.symbol !== null) return basis.symbol;
  if (basis.poolCount !== null) return `证券池 ${basis.poolCount} 只`;
  return "档案未记录证券范围";
}
