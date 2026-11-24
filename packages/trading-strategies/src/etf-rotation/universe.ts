import { isCnEtfSymbol } from "trading-strategy-core/costs";

export type EtfAssetClass =
  "broad_equity" | "dividend" | "sector" | "gold" | "treasury" | "cross_border";

export type EtfRotationInstrument = Readonly<{
  symbol: string;
  name: string;
  assetClass: EtfAssetClass;
  indexGroup: string;
  isLegacyLongHistory: boolean;
  isCrossBorder: boolean;
}>;

function etf(
  symbol: string,
  name: string,
  assetClass: EtfAssetClass,
  indexGroup: string,
  isLegacyLongHistory = false,
): EtfRotationInstrument {
  if (!isCnEtfSymbol(symbol)) throw new Error("Invalid ETF code: " + symbol);
  return Object.freeze({
    symbol,
    name,
    assetClass,
    indexGroup,
    isLegacyLongHistory,
    isCrossBorder: assetClass === "cross_border",
  });
}

/** Fixed research selection. Legacy means local history beginning before 2015. */
export const etfRotationUniverse: readonly EtfRotationInstrument[] =
  Object.freeze([
    etf("sh510300", "沪深300ETF", "broad_equity", "csi-300", true),
    etf("sh510500", "中证500ETF", "broad_equity", "csi-500", true),
    etf("sz159915", "创业板ETF", "broad_equity", "chinext", true),
    etf("sh588000", "科创50ETF", "broad_equity", "star-50"),
    etf("sh510050", "上证50ETF", "broad_equity", "sse-50", true),
    etf("sh510880", "红利ETF", "dividend", "sse-dividend", true),
    etf("sh518880", "黄金ETF", "gold", "sge-au9999", true),
    etf("sh511010", "国债ETF", "treasury", "sse-5y-treasury", true),
    etf("sh513100", "纳指ETF", "cross_border", "nasdaq-100", true),
    etf("sh513500", "标普500ETF", "cross_border", "sp-500", true),
    etf("sh512480", "半导体ETF", "sector", "csi-semiconductor"),
    etf("sh512880", "证券ETF", "sector", "csi-securities"),
    etf("sh512800", "银行ETF", "sector", "csi-bank"),
    etf("sh512010", "医药ETF", "sector", "csi-300-health-care", true),
    etf("sz159928", "消费ETF", "sector", "csi-consumer-staples", true),
    etf("sh516160", "新能源ETF", "sector", "csi-new-energy"),
    etf("sh512660", "军工ETF", "sector", "csi-defense"),
    etf("sh512690", "酒ETF", "sector", "csi-liquor"),
    etf("sh512980", "传媒ETF", "sector", "csi-media"),
    etf("sh515220", "煤炭ETF", "sector", "csi-coal"),
    etf("sh512400", "有色金属ETF", "sector", "csi-nonferrous"),
  ]);
