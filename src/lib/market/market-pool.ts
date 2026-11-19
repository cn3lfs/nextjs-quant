import { isRpsMarketSymbol, rpsPeriods, type RpsValue } from "quant-rps";
import { z } from "zod";
import { sortTableRows, tableSortSchema } from "../common/server-sort";

export const poolCategorySchema = z.enum(["industry", "concept", "index"]);
export const poolCategoryLabels = {
  industry: "申万行业",
  concept: "概念",
  index: "中证指数",
} as const;
export const poolSelectionSchema = z.object({
  category: poolCategorySchema,
  name: z
    .string()
    .min(1)
    .max(128)
    .refine((s) => !/[\\/\x00-\x1f]/.test(s), "名单名称非法"),
});
/**
 * Deep link into the standalone stock pool route.
 * Used by the板块 RPS tables so a ranked name opens its成分股.
 */
export function poolMembersHref(
  category: z.infer<typeof poolCategorySchema>,
  name: string,
) {
  return `/scan?tab=pool&poolCategory=${category}&poolName=${encodeURIComponent(name)}`;
}
/** One AND condition: the security's RPS for `period` must satisfy the threshold. */
export const marketPoolRpsConditionSchema = z.object({
  period: z
    .number()
    .refine(
      (n) => (rpsPeriods as readonly number[]).includes(n),
      "不支持的RPS周期",
    ),
  side: z.enum(["gte", "lte"]),
  value: z.number().int().min(0).max(100),
});
export type MarketPoolRpsCondition = z.infer<
  typeof marketPoolRpsConditionSchema
>;
/** Zero conditions reproduce the old unfiltered pool; at most three combine with AND. */
export const marketPoolRpsConditionsSchema = z
  .array(marketPoolRpsConditionSchema)
  .max(3)
  .default([])
  .refine(
    (conditions) =>
      new Set(conditions.map((condition) => condition.period)).size ===
      conditions.length,
    "RPS条件周期不能重复",
  );
export const marketPoolQuerySchema = z.object({
  pool: poolSelectionSchema.nullable().default(null),
  search: z.string().trim().max(80).default(""),
  period: z
    .number()
    .refine((n) => (rpsPeriods as readonly number[]).includes(n))
    .default(50),
  minimumRps: z.number().min(0).max(100).nullable().default(null),
  conditions: marketPoolRpsConditionsSchema,
  sort: z.enum(["rps", "symbol"]).default("rps"),
  /** Column header sort; overrides `sort` across the whole filtered pool. */
  order: tableSortSchema,
  page: z.number().int().min(0).max(1000).default(0),
  selected: z
    .string()
    .regex(/^(sh|sz|bj)\d{6}$/)
    .optional(),
});
export type MarketPoolQuery = z.infer<typeof marketPoolQuerySchema>;
export type MarketPoolAvailability = {
  rps: "missing" | "period-missing" | "ready";
  dailyIndex: "not-scanned" | "empty" | "ready";
};
export type MarketPoolRow = {
  symbol: string;
  name: string;
  identity?: {
    status: "delisted" | "code-changed";
    date: string;
    successor?: string;
    source: string;
    fetchedAt: string;
  } | null;
  localDay: boolean;
  fullDayCache?: boolean;
  value: RpsValue | null;
  /** Condition-period ranks from the same batch; present only with conditions. */
  conditionValues?: Record<string, RpsValue | null>;
  reason: string | null;
};

/** Filtering never recomputes ranks: every value retains its full-market denominator. */
export function selectMarketPoolRows(
  rows: MarketPoolRow[],
  input: MarketPoolQuery,
) {
  const needle = input.search.toLowerCase();
  const conditions = input.conditions;
  const filtered = rows
    .filter(
      (row) =>
        isRpsMarketSymbol(row.symbol) &&
        (!needle ||
          row.symbol.includes(needle) ||
          row.name.toLowerCase().includes(needle)) &&
        (input.minimumRps === null ||
          (row.value !== null && row.value.rps >= input.minimumRps)) &&
        // Missing condition values never match, including at threshold 0.
        conditions.every((condition) => {
          const rps = row.conditionValues?.[String(condition.period)]?.rps;
          return (
            rps !== null &&
            rps !== undefined &&
            (condition.side === "gte"
              ? rps >= condition.value
              : rps <= condition.value)
          );
        }),
    )
    .sort(
      (a, b) =>
        (input.sort === "rps"
          ? (a.value?.rank ?? Infinity) - (b.value?.rank ?? Infinity)
          : 0) || a.symbol.localeCompare(b.symbol),
    );
  return sortTableRows(filtered, input.order, {
    symbol: (row) => row.symbol,
    name: (row) => row.name,
    rps: (row) => row.value?.rps,
    rank: (row) => row.value?.rank,
    reason: (row) => row.reason,
    return: (row) => row.value?.return,
    status: (row) => (row.localDay || row.fullDayCache ? 1 : 0),
  });
}
