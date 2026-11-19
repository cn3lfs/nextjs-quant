import {
  poolCategorySchema,
  poolSelectionSchema,
  marketPoolQuerySchema,
  type MarketPoolQuery,
} from "./market-pool";

/** URL state predates RPS conditions; keep its object shape unchanged. */
export type MarketPoolLocationQuery = Omit<MarketPoolQuery, "conditions">;
export type MarketPoolLocation = {
  category: "all" | "industry" | "concept" | "index";
  query: MarketPoolLocationQuery;
};

/** Every filter needed to reopen the pool lives in its URL, not a cached page DOM. */
export function readMarketPoolLocation(search: string): MarketPoolLocation {
  const params = new URLSearchParams(search);
  const category = poolCategorySchema.safeParse(params.get("poolCategory"));
  const pool = poolSelectionSchema.safeParse({
    category: category.data,
    name: params.get("poolName"),
  });
  const numeric = (key: string) => {
    const value = params.get(key);
    return value?.trim() ? Number(value) : undefined;
  };
  const searchText = params.get("search") ?? "";
  const fields = marketPoolQuerySchema.shape;
  return {
    category: category.success ? category.data : "all",
    query: {
      // Conditions are session-only on the stock RPS panel, not URL state.
      pool: pool.success ? pool.data : null,
      // Keep typing spaces; the API trims its own input when searching.
      search: searchText.length <= 80 ? searchText : "",
      period: fields.period.catch(50).parse(numeric("period")),
      minimumRps: fields.minimumRps.catch(null).parse(numeric("minimumRps")),
      sort: fields.sort.catch("rps").parse(params.get("sort") ?? undefined),
      order: fields.order.catch(null).parse(
        ["symbol", "rps", "return", "status"].includes(
          params.get("sortColumn") ?? "",
        )
          ? {
              id: params.get("sortColumn"),
              desc: params.get("descending") === "true",
            }
          : null,
      ),
      page: fields.page.catch(0).parse(numeric("page")),
      selected: fields.selected
        .catch(undefined)
        .parse(params.get("selected") ?? undefined),
    },
  };
}

export function marketPoolLocationHref({
  category,
  query,
}: MarketPoolLocation) {
  const params = new URLSearchParams();
  if (category !== "all") params.set("poolCategory", category);
  if (query.pool) params.set("poolName", query.pool.name);
  if (query.search) params.set("search", query.search);
  if (query.period !== 50) params.set("period", String(query.period));
  if (query.minimumRps !== null)
    params.set("minimumRps", String(query.minimumRps));
  if (query.sort !== "rps") params.set("sort", query.sort);
  if (query.order) {
    params.set("sortColumn", query.order.id);
    params.set("descending", String(query.order.desc));
  }
  if (query.page) params.set("page", String(query.page));
  if (query.selected) params.set("selected", query.selected);
  return `/scan?tab=pool${params.size ? `&${params}` : ""}`;
}
