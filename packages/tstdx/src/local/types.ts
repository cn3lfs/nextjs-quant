/** Local client file contracts. No application, database or UI dependencies. */
export type TdxLocalPeriod = "day" | "5m";
export type TdxLocalBar = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
};
export type TdxLocalSecurity = {
  symbol: string;
  name: string;
  market: string;
  bytes: number;
  modified: number;
  period: TdxLocalPeriod;
};
export type TdxLocalCoverage = {
  root: string;
  counts: Record<string, number>;
  securities: TdxLocalSecurity[];
  scannedAt: number;
};
export type TdxLocalSnapshot = {
  id: string;
  symbol: string;
  name?: string;
  period: TdxLocalPeriod;
  source: string;
  adjustment: "none";
  createdAt: number;
  bars: TdxLocalBar[];
  hash: string;
  historicalAsOf?: string;
  dataRoot?: string;
  sourceNote?: string;
};
export type TdxLocalAdjustment = "none" | "forward" | "backward";
export function validateLocalSymbol(value: string) {
  if (!/^(sh|sz|bj)\d{6}$/.test(value)) throw new Error("通达信证券代码非法");
  return value;
}
export function validateLocalDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(+date) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error("通达信日期非法");
  return value;
}
export const isLocalMarketIndex = (symbol: string) =>
  /^(sh(000|880|881|885|886|93\d|95\d)|sz399)\d{3}$/.test(symbol);
export const isLocalPriceScaleThreeFund = (symbol: string) =>
  /^(?:sh(?:50|51|52|53|56|58)|sz(?:15|16))\d{4}$/.test(symbol);
