export type ThsdkOrderBookLevelState = "quoted" | "empty" | "unknown";
export type ThsdkOrderBookLevel = {
  level: number;
  price: number | null;
  volume: number | null;
  state: ThsdkOrderBookLevelState;
};
export type ThsdkOrderBookItem = {
  symbol: string;
  status: "ok" | "empty" | "unavailable" | "invalid";
  bids: ThsdkOrderBookLevel[];
  asks: ThsdkOrderBookLevel[];
  volumeUnit: "股" | "份" | "指数源字段" | "源单位未独立核验";
  fetchedAt: number;
  dataAsOf: string | null;
  delayed: "unverified" | "delayed" | "verified";
  message?: string;
};
export type ThsdkOrderBooksResponse = {
  version: string;
  source: "thsdk-hq";
  fetchedAt: number;
  items: ThsdkOrderBookItem[];
};
export type ThsdkPriceVolumeLevel = {
  price: number;
  volume: number;
  inVolume: number | null;
  outVolume: number | null;
  transactionCount: number | null;
  outVolumeRate: number | null;
};
export type ThsdkPriceVolumeResult = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  fetchedAt: number;
  dataAsOf: string | null;
  volumeUnit: string;
  levels: ThsdkPriceVolumeLevel[];
};
export type ThsdkCallAuctionPoint = {
  time: string;
  timestamp: number;
  price: number;
  curVolume: number;
  bid2Vol: number | null;
  ask2Vol: number | null;
};
export type ThsdkCallAuctionResult = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  phase: "opening" | "closing";
  date: string;
  fetchedAt: number;
  points: ThsdkCallAuctionPoint[];
};
export type ThsdkIntradayPoint = {
  time: string;
  price: number;
  volume: number;
  turnover: number;
};
export type ThsdkIntradayResult = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  date: string | null;
  fetchedAt: number;
  volumeUnit: string;
  points: ThsdkIntradayPoint[];
};
export type ThsdkCapitalFlowItem = {
  symbol: string;
  source: "thsdk-hq";
  fetchedAt: number;
  turnover: number | null;
  activeBuyXLarge: number | null;
  activeSellXLarge: number | null;
  activeBuyLarge: number | null;
  activeSellLarge: number | null;
  passiveBuyXLarge: number | null;
  passiveSellXLarge: number | null;
  passiveBuyLarge: number | null;
  passiveSellLarge: number | null;
  activeBuyMedium: number | null;
  activeSellMedium: number | null;
  passiveBuyMedium: number | null;
  passiveSellMedium: number | null;
  activeBuySmall: number | null;
  activeSellSmall: number | null;
  mainNetInflow: number | null;
};
export type ThsdkCapitalFlowsResponse = {
  version: string;
  source: "thsdk-hq";
  fetchedAt: number;
  items: ThsdkCapitalFlowItem[];
};
export type ThsdkPopularityResult = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  fetchedAt: number;
  rank: number | null;
  rankAmount: number | null;
  rankChange: number | null;
};
