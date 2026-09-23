export const commonIndices = [
  { symbol: "sh000001", name: "上证指数" },
  { symbol: "sz399001", name: "深证成指" },
  { symbol: "sz399006", name: "创业板指" },
  { symbol: "sh000016", name: "上证50" },
  { symbol: "sh000300", name: "沪深300" },
  { symbol: "sh000905", name: "中证500" },
  { symbol: "sh000852", name: "中证1000" },
] as const;
export const isMarketIndex = (symbol: string) =>
  /^(sh(000|880|881|885|886|93\d|95\d)|sz399)\d{3}$/.test(symbol);
export const commonIndexName = (symbol: string) =>
  commonIndices.find((row) => row.symbol === symbol)?.name;
