import { z } from "zod";

export const thsdkRealtimeSignalSchema = z.enum([
  "limit_up",
  "limit_down",
  "limit_up_break",
  "limit_down_break",
]);
export const thsdkMarketScopeSchema = z.enum(["USHA", "USZA", "USTA"]);

export type ThsdkLimitUpAttribution = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  date: string;
  fetchedAt: number;
  available: boolean;
  statusMessage: string | null;
  reason: string | null;
  reasons: string[];
  concepts: string[];
  firstLimitUpTime: string | null;
  lastLimitUpTime: string | null;
  openCount: number | null;
  streakDays: number | null;
  highDays: string | null;
  limitUpType: string | null;
};

export type ThsdkRealtimeSignalItem = {
  symbol: string | null;
  code: string;
  market: string;
  name: string | null;
  price: number | null;
  changePct: number | null;
  signalTime: string | null;
  reason: string | null;
};

export type ThsdkRealtimeSignalResult = {
  version: string;
  source: "thsdk-hq";
  signal: z.infer<typeof thsdkRealtimeSignalSchema>;
  markets: z.infer<typeof thsdkMarketScopeSchema>[];
  fetchedAt: number;
  available: boolean;
  emptyReason: string | null;
  items: ThsdkRealtimeSignalItem[];
};

export type ThsdkMarketChangeEvent = {
  id: string;
  title: string;
  mainTitle: string;
  eventType: string | null;
  publishedAt: string | null;
  relatedSecurities: { symbol: string | null; code: string; name: string }[];
};

export type ThsdkMarketChangeEventsResult = {
  version: string;
  source: "thsdk-hq";
  fetchedAt: number;
  items: ThsdkMarketChangeEvent[];
};

export type ThsdkCallAuctionUnusualItem = {
  symbol: string | null;
  code: string;
  name: string | null;
  eventType: string | null;
  title: string;
  detail: string | null;
  eventTime: string | null;
  changePct: number | null;
};

export type ThsdkCallAuctionUnusualResult = {
  version: string;
  source: "thsdk-hq";
  market: "USHA" | "USZA";
  tradeDate: string | null;
  fetchedAt: number;
  available: boolean;
  emptyReason: string | null;
  items: ThsdkCallAuctionUnusualItem[];
};

export type ThsdkConceptTag = {
  name: string;
  kind: "bond" | "normal" | "other";
  score: number | null;
  order: number | null;
};

export type ThsdkBlockMembership = {
  blockId: number;
  blockName: string;
  indexCode: string | null;
  count: number | null;
  kind: string | null;
};

export type ThsdkSecurityBlocksProfile = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  fetchedAt: number;
  industry: { code: string | null; name: string } | null;
  conceptTags: ThsdkConceptTag[];
  memberships: ThsdkBlockMembership[];
};

export type ThsdkBlockConstituentItem = {
  symbol: string | null;
  code: string;
  market: string;
  name: string | null;
  price: number | null;
  changePct: number | null;
};

export type ThsdkBlockConstituentsResult = {
  version: string;
  source: "thsdk-hq";
  blockId: number;
  blockName: string | null;
  fetchedAt: number;
  items: ThsdkBlockConstituentItem[];
};
