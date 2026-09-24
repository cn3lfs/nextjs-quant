import { z } from "zod";

/**
 * Commodity futures chart symbols: `fu` + an upper-cased Eastmoney contract
 * code, e.g. `fuGC00Y` (COMEX gold continuous) or `fuAUM` (SHFE gold main).
 * Only the fixed list below is supported; no free-form contract search.
 */
export const futuresGroups = ["贵金属", "基本金属", "能源"] as const;
export type FuturesGroup = (typeof futuresGroups)[number];
export type FuturesContract = {
  symbol: string;
  /** Eastmoney `market.code`; absent when Eastmoney has no such contract. */
  secid?: string;
  /** Yahoo Finance continuous front-month symbol (foreign contracts only). */
  yahoo?: string;
  name: string;
  exchange: string;
  unit: string;
  group: FuturesGroup;
  precision: number;
  /** Sina daily-kline fallback; `scale` converts Sina's quote unit to ours. */
  sina?: { service: "global" | "inner"; code: string; scale?: number };
};

export const futuresContracts: readonly FuturesContract[] = [
  {
    symbol: "fuGC00Y",
    yahoo: "GC=F",
    secid: "101.GC00Y",
    name: "COMEX 黄金",
    exchange: "COMEX",
    unit: "美元/盎司",
    group: "贵金属",
    precision: 1,
    sina: { service: "global", code: "GC" },
  },
  {
    symbol: "fuAUM",
    secid: "113.aum",
    name: "沪金主连",
    exchange: "上期所",
    unit: "元/克",
    group: "贵金属",
    precision: 2,
    sina: { service: "inner", code: "AU0" },
  },
  {
    symbol: "fuSI00Y",
    yahoo: "SI=F",
    secid: "101.SI00Y",
    name: "COMEX 白银",
    exchange: "COMEX",
    unit: "美元/盎司",
    group: "贵金属",
    precision: 3,
    sina: { service: "global", code: "SI" },
  },
  {
    symbol: "fuAGM",
    secid: "113.agm",
    name: "沪银主连",
    exchange: "上期所",
    unit: "元/千克",
    group: "贵金属",
    precision: 0,
    sina: { service: "inner", code: "AG0" },
  },
  {
    symbol: "fuHG00Y",
    yahoo: "HG=F",
    secid: "101.HG00Y",
    name: "COMEX 铜",
    exchange: "COMEX",
    unit: "美元/磅",
    group: "基本金属",
    precision: 4,
    sina: { service: "global", code: "HG", scale: 0.01 },
  },
  {
    symbol: "fuCUM",
    secid: "113.cum",
    name: "沪铜主连",
    exchange: "上期所",
    unit: "元/吨",
    group: "基本金属",
    precision: 0,
    sina: { service: "inner", code: "CU0" },
  },
  {
    symbol: "fuALM",
    secid: "113.alm",
    name: "沪铝主连",
    exchange: "上期所",
    unit: "元/吨",
    group: "基本金属",
    precision: 0,
    sina: { service: "inner", code: "AL0" },
  },
  {
    symbol: "fuALI",
    yahoo: "ALI=F",
    name: "COMEX 铝",
    exchange: "COMEX",
    unit: "美元/吨",
    group: "基本金属",
    precision: 1,
  },
  {
    symbol: "fuCL00Y",
    yahoo: "CL=F",
    secid: "102.CL00Y",
    name: "WTI 原油",
    exchange: "NYMEX",
    unit: "美元/桶",
    group: "能源",
    precision: 2,
    sina: { service: "global", code: "CL" },
  },
  {
    symbol: "fuB00Y",
    yahoo: "BZ=F",
    secid: "112.B00Y",
    name: "布伦特原油",
    exchange: "ICE",
    unit: "美元/桶",
    group: "能源",
    precision: 2,
    sina: { service: "global", code: "OIL" },
  },
  {
    symbol: "fuSCM",
    secid: "142.scm",
    name: "上海原油主连",
    exchange: "上期能源",
    unit: "元/桶",
    group: "能源",
    precision: 1,
    sina: { service: "inner", code: "SC0" },
  },
];

/** User-selectable futures source; `auto` runs the Yahoo → Eastmoney → Sina chain. */
export const futuresSourceSchema = z.enum([
  "auto",
  "yahoo",
  "eastmoney",
  "sina",
]);
export type FuturesSource = z.infer<typeof futuresSourceSchema>;
export const futuresSourceLabels: Record<FuturesSource, string> = {
  auto: "自动（Yahoo → 东方财富 → 新浪）",
  yahoo: "Yahoo Finance",
  eastmoney: "东方财富",
  sina: "新浪（仅日线）",
};
/** Whether a contract has a code on the source (Sina also needs daily bars). */
export function futuresSourceSupports(
  contract: FuturesContract,
  source: FuturesSource,
) {
  return source === "auto"
    ? true
    : source === "yahoo"
      ? !!contract.yahoo
      : source === "eastmoney"
        ? !!contract.secid
        : !!contract.sina;
}

export const futuresSymbolSchema = z
  .string()
  .refine(
    (s) => futuresContracts.some((c) => c.symbol === s),
    "不支持的期货品种",
  );
export const futuresContract = (symbol: string) =>
  futuresContracts.find((c) => c.symbol === symbol);
export const isFuturesSymbol = (symbol: string) => !!futuresContract(symbol);
