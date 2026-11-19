import { z } from "zod";
import { thsdkMarketScopeSchema } from "./thsdk-sentiment";

export const thsdkWencaiQueryInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  markets: z.array(thsdkMarketScopeSchema).max(3).optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

export type ThsdkWencaiField = {
  key: string;
  label: string;
  unit: string | null;
  type: string | null;
};

export type ThsdkWencaiRow = {
  symbol: string | null;
  code: string;
  market: string;
  name: string | null;
  values: Record<string, string | number | boolean | null>;
};

export type ThsdkWencaiQueryResult = {
  version: string;
  source: "thsdk-hq";
  query: string;
  fetchedAt: number;
  fields: ThsdkWencaiField[];
  rows: ThsdkWencaiRow[];
};

export const thsdkHotBlockKindSchema = z.enum(["concept", "industry"]);

export type ThsdkHotBlockItem = {
  blockId: number;
  name: string;
  order: number | null;
  rate: number | null;
  tag: string | null;
  hotTag: string | null;
  etfName: string | null;
};

export type ThsdkHotBlocksResult = {
  version: string;
  source: "thsdk-hq";
  kind: "concept" | "industry";
  fetchedAt: number;
  items: ThsdkHotBlockItem[];
};

export const THSDK_NEWS_FLASH_MAX_PAGE = 20;

export const thsdkNewsFlashInputSchema = z.object({
  page: z.number().int().min(1).max(THSDK_NEWS_FLASH_MAX_PAGE).default(1),
  pageSize: z.number().int().min(1).max(50).default(20),
  tag: z.string().trim().max(40).optional(),
});

export type ThsdkNewsFlashItem = {
  id: string;
  seq: string | null;
  title: string;
  digest: string | null;
  url: string | null;
  tags: string[];
  publishedAt: number | null;
  important: boolean;
};

export type ThsdkNewsFlashResult = {
  version: string;
  source: "thsdk-hq";
  page: number;
  pageSize: number;
  total: number | null;
  fetchedAt: number;
  filters: { id: string; name: string }[];
  items: ThsdkNewsFlashItem[];
};

export type ThsdkResearchReportItem = {
  id: string;
  title: string;
  publishedAt: string | null;
  org: string | null;
  researcher: string | null;
  abstract: string | null;
  url: string | null;
};

export type ThsdkResearchReportsResult = {
  version: string;
  source: "thsdk-hq";
  symbol: string;
  fetchedAt: number;
  items: ThsdkResearchReportItem[];
};
