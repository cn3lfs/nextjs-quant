import { z } from "zod";

/**
 * Commodity futures chart symbols: `fu` + an upper-cased Eastmoney contract
 * code, e.g. `fuGC00Y` (COMEX gold continuous) or `fuAUM` (SHFE gold main).
 * Only the fixed list below is supported; no free-form contract search.
 */
export const futuresGroups = ["贵金属", "基本金属", "黑色系", "能源"] as const;
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
  /** Quantity in the displayed quote unit for one lot. */
  contractMultiplier: number;
  group: FuturesGroup;
  precision: number;
  /** Sina daily-kline fallback; `scale` converts Sina's quote unit to ours. */
  sina?: { service: "global" | "inner"; code: string; scale?: number };
};

export const futuresContracts: readonly FuturesContract[] = [
  {
    symbol: "fuGC00Y",
    contractMultiplier: 100,
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
    contractMultiplier: 1000,
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
    contractMultiplier: 5000,
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
    contractMultiplier: 15,
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
    contractMultiplier: 25000,
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
    contractMultiplier: 5,
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
    contractMultiplier: 5,
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
    contractMultiplier: 25,
    yahoo: "ALI=F",
    name: "COMEX 铝",
    exchange: "COMEX",
    unit: "美元/吨",
    group: "基本金属",
    precision: 2,
  },
  {
    symbol: "fuRBM",
    contractMultiplier: 10,
    secid: "113.rbm",
    name: "螺纹钢主连",
    exchange: "上期所",
    unit: "元/吨",
    group: "黑色系",
    precision: 0,
    sina: { service: "inner", code: "RB0" },
  },
  {
    symbol: "fuIM",
    contractMultiplier: 100,
    secid: "114.im",
    name: "铁矿石主连",
    exchange: "大商所",
    unit: "元/吨",
    group: "黑色系",
    precision: 1,
    sina: { service: "inner", code: "I0" },
  },
  {
    // Eastmoney's `jmm` is coking coal and `jm` is coke (the reverse of the
    // exchange product codes JM / J).
    symbol: "fuJMM",
    contractMultiplier: 60,
    secid: "114.jmm",
    name: "焦煤主连",
    exchange: "大商所",
    unit: "元/吨",
    group: "黑色系",
    precision: 1,
    sina: { service: "inner", code: "JM0" },
  },
  {
    symbol: "fuJM",
    contractMultiplier: 100,
    secid: "114.jm",
    name: "焦炭主连",
    exchange: "大商所",
    unit: "元/吨",
    group: "黑色系",
    precision: 1,
    sina: { service: "inner", code: "J0" },
  },
  {
    symbol: "fuCL00Y",
    contractMultiplier: 1000,
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
    contractMultiplier: 1000,
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
    contractMultiplier: 1000,
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
  auto: "自动",
  yahoo: "Yahoo",
  eastmoney: "东方财富",
  sina: "新浪日线",
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
