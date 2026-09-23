import { z } from "zod";
import { isRpsMarketSymbol, rpsPeriods, type RpsValue } from "./rps";

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
 * Deep link into the stock pool browser, which reads these parameters on mount.
 * Used by the板块 RPS tables so a ranked name opens its成分股.
 */
export function poolMembersHref(
  category: z.infer<typeof poolCategorySchema>,
  name: string,
) {
  return `/market?poolCategory=${category}&poolName=${encodeURIComponent(name)}`;
}
export const marketPoolQuerySchema = z.object({
  pool: poolSelectionSchema.nullable().default(null),
  search: z.string().trim().max(80).default(""),
  period: z
    .number()
    .refine((n) => (rpsPeriods as readonly number[]).includes(n))
    .default(50),
  minimumRps: z.number().min(0).max(100).nullable().default(null),
  sort: z.enum(["rps", "symbol"]).default("rps"),
  page: z.number().int().min(0).max(1000).default(0),
  selected: z
    .string()
    .regex(/^(sh|sz|bj)\d{6}$/)
    .optional(),
});
export type MarketPoolQuery = z.infer<typeof marketPoolQuerySchema>;
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
  reason: string | null;
};

/** Filtering never recomputes ranks: every value retains its full-market denominator. */
export function selectMarketPoolRows(
  rows: MarketPoolRow[],
  input: MarketPoolQuery,
) {
  const needle = input.search.toLowerCase();
  return rows
    .filter(
      (row) =>
        isRpsMarketSymbol(row.symbol) &&
        (!needle ||
          row.symbol.includes(needle) ||
          row.name.toLowerCase().includes(needle)) &&
        (input.minimumRps === null ||
          (row.value !== null && row.value.rps >= input.minimumRps)),
    )
    .sort(
      (a, b) =>
        (input.sort === "rps"
          ? (a.value?.rank ?? Infinity) - (b.value?.rank ?? Infinity)
          : 0) || a.symbol.localeCompare(b.symbol),
    );
}
