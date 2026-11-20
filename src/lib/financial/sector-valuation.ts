import { z } from "zod";
import { financialIsoDate } from "./local-financial";

/**
 * 板块估值百分位：通达信本地 `gpsh<code>.dat` 的 BK5 首列 PE-TTM 与
 * BK6 首列 PB-MRQ（均为整体法）。分类与代码只取自板块主档，不按名称合并。
 */
export const sectorValuationCategories = ["industry", "concept"] as const;
export type SectorValuationCategory =
  (typeof sectorValuationCategories)[number];
export const sectorValuationSorts = [
  "pe",
  "pe5",
  "pe10",
  "peAll",
  "pb",
  "pb5",
  "pb10",
  "pbAll",
] as const;
export type SectorValuationSort = (typeof sectorValuationSorts)[number];

/** 北京时间自然日；与既有本地读取一致，不依赖进程时区。 */
export function beijingCalendarDate(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export const sectorValuationInput = z
  .object({
    category: z.enum(sectorValuationCategories).default("industry"),
    sort: z.enum(sectorValuationSorts).default("pe5"),
    descending: z.boolean().default(false),
    pageIndex: z.number().int().min(0).default(0),
    pageSize: z.number().int().min(1).max(100).default(50),
    asOf: financialIsoDate.optional(),
    /** 跳过派生摘要缓存并重读本地序列。 */
    refresh: z.boolean().default(false),
  })
  .refine(
    (input) => !input.asOf || input.asOf <= beijingCalendarDate(),
    "截止日不能晚于当前北京时间",
  );
export type SectorValuationInput = z.infer<typeof sectorValuationInput>;

export type SectorValuationWindow = {
  years: 5 | 10 | "all";
  /** 观察日往前 N 个自然年的窗口起点（全历史为本地序列起点）。 */
  windowStart: string | null;
  /** 窗口内最早的有效样本日。 */
  sampleStart: string | null;
  /** 本地序列起点是否早于或等于窗口起点。 */
  complete: boolean;
  /** 有效样本数：同源、同日去重清晰、正有限历史值。 */
  samples: number;
  /** 不高于当前值的有效样本数。 */
  notAbove: number | null;
  /** notAbove / samples * 100；不可计算时为 null。 */
  percentile: number | null;
  reason: string | null;
};

export type SectorValuationMissing =
  | "no-file"
  | "no-record"
  | "duplicate"
  | "missing-date"
  | "missing-on-date"
  | null;

export type SectorValuationMetric = {
  /** 最新对齐日的原始倍数；非正也保留。 */
  value: number | null;
  missing: SectorValuationMissing;
  y5: SectorValuationWindow;
  y10: SectorValuationWindow;
  yAll?: SectorValuationWindow;
};

export type SectorValuationRow = {
  category: SectorValuationCategory;
  classification: "tdx-research" | "tdx-concept";
  code: string | null;
  name: string;
  symbol: string | null;
  status: "ok" | "unavailable";
  /** 整个序列不可用时的原因；单值缺失见各 metric.missing。 */
  reason: string | null;
  /** 两值共同对齐的最新记录日，不晚于截止日。 */
  date: string | null;
  pe: SectorValuationMetric;
  pb: SectorValuationMetric;
  sourceFirst: string | null;
  sourceLast: string | null;
};

export type SectorValuationResult = {
  version: string;
  available: boolean;
  state: "ok" | "source-unconfigured" | "blocks-unavailable";
  reason: string | null;
  /** 请求的截止日（北京时间自然日）。 */
  requestedDate: string;
  category: SectorValuationCategory;
  classification: "tdx-research" | "tdx-concept";
  counts: { industry: number; concept: number };
  coverage: {
    blocks: number;
    readable: number;
    first: string | null;
    last: string | null;
  };
  observation: {
    date: string | null;
    window5: string | null;
    window10: string | null;
  };
  rows: SectorValuationRow[];
  total: number;
  pageIndex: number;
  pageSize: number;
  sort: SectorValuationSort;
  descending: boolean;
  cached: boolean;
  warning: string | null;
  generatedAt: number;
};
