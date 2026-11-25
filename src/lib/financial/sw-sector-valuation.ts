import { z } from "zod";

export const swSectorLevels = ["l1", "l2"] as const;
export type SwSectorLevel = (typeof swSectorLevels)[number];

export const swSectorValuationSorts = [
  "pePct",
  "pe",
  "pbPct",
  "pb",
  "divPct",
  "div",
] as const;
export type SwSectorValuationSort = (typeof swSectorValuationSorts)[number];

export const swSectorValuationInput = z.object({
  level: z.enum(swSectorLevels).default("l1"),
  parentL1: z.string().trim().max(40).optional(),
  search: z.string().trim().max(40).default(""),
  sort: z.enum(swSectorValuationSorts).default("pePct"),
  descending: z.boolean().default(false),
  refresh: z.boolean().default(false),
});

export type SwSectorValuationRow = {
  code: string;
  swCode: string;
  name: string;
  level: SwSectorLevel;
  parentL1: string | null;
  endDate: string | null;
  pe: number | null;
  pePct: number | null;
  pePrevM: number | null;
  pePrevY: number | null;
  pb: number | null;
  pbPct: number | null;
  pbPrevM: number | null;
  pbPrevY: number | null;
  div: number | null;
  divPct: number | null;
  divPrevM: number | null;
  divPrevY: number | null;
  missing: boolean;
};

export type SwSectorValuationResult = {
  version: "sw-sector-valuation-1";
  source: "tencent/westock-data";
  available: boolean;
  reason: string | null;
  level: SwSectorLevel;
  parentL1: string | null;
  search: string;
  sort: SwSectorValuationSort;
  descending: boolean;
  counts: { l1: number; l2: number };
  l1Names: string[];
  asOfDate: string | null;
  fetchedAt: number;
  cached: boolean;
  missingCount: number;
  warning: string | null;
  rows: SwSectorValuationRow[];
  total: number;
};
