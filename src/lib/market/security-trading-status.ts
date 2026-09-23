export type SecurityTradingStatus = {
  version: "security-trading-status-1";
  symbol: string;
  status: "trading" | "suspended" | "unknown";
  asOf: string | null;
  fetchedAt: number;
  source: string;
  reason: string;
  evidence: {
    row: Record<string, unknown>;
    columns: {
      key: string;
      index_name?: string;
      type?: string;
      timestamp?: string;
    }[];
  };
  evidenceHash: string;
};
export function chinaDate(now: number) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}
export function currentTradingStatus(
  check: SecurityTradingStatus | null | undefined,
  symbol: string,
  now: number,
) {
  return Boolean(
    check &&
    check.symbol === symbol &&
    check.status === "trading" &&
    check.asOf === chinaDate(now) &&
    now >= check.fetchedAt &&
    now - check.fetchedAt < 60000,
  );
}
