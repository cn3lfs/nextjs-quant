import { z } from "zod";
import { chartSymbolHref } from "../chart/chart-symbol";
import { instrumentSchema } from "../market/instrument";
import { accountPageSchema, type AccountPosition } from "./account-workspace";

/** The existing list contract also owns the URL shape, so a filter can never
 *  drift between the page request and the address bar. */
export type HoldingsFilters = z.infer<typeof accountPageSchema>;

export const holdingsFilterKeys = {
  kind: "holdings_kind",
  source: "holdings_source",
  market: "holdings_market",
  stopStatus: "holdings_stop",
  group: "holdings_group",
  sleeve: "holdings_sleeve",
  page: "holdings_page",
} as const satisfies Record<keyof HoldingsFilters, string>;

export const defaultHoldingsFilters: HoldingsFilters = accountPageSchema.parse(
  {},
);

/** Missing, blank or out-of-contract values fall back to the same defaults the
 *  server applies; never coerce by prefix or infer a source for non-real kinds. */
export function readHoldingsFilters(
  search: string | URLSearchParams,
): HoldingsFilters {
  const params =
      typeof search === "string" ? new URLSearchParams(search) : search,
    fields = accountPageSchema.shape,
    text = (key: string) => params.get(key) ?? undefined,
    number = (key: string) => {
      const value = params.get(key);
      return value?.trim() ? Number(value) : undefined;
    };
  const kind = fields.kind
    .catch(defaultHoldingsFilters.kind)
    .parse(text(holdingsFilterKeys.kind));
  return {
    kind,
    // Sources exist only on real accounts; other kinds normalize to all.
    source:
      kind === "real"
        ? fields.source
            .catch(defaultHoldingsFilters.source)
            .parse(text(holdingsFilterKeys.source))
        : "all",
    market: fields.market
      .catch(defaultHoldingsFilters.market)
      .parse(text(holdingsFilterKeys.market)),
    stopStatus: fields.stopStatus
      .catch(defaultHoldingsFilters.stopStatus)
      .parse(text(holdingsFilterKeys.stopStatus)),
    group: fields.group
      .catch(defaultHoldingsFilters.group)
      .parse(text(holdingsFilterKeys.group)),
    sleeve: fields.sleeve
      .catch(defaultHoldingsFilters.sleeve)
      .parse(text(holdingsFilterKeys.sleeve)),
    page: fields.page
      .catch(defaultHoldingsFilters.page)
      .parse(number(holdingsFilterKeys.page)),
  };
}

/** Writes only the holdings keys. Defaults are omitted, and every other URL
 *  parameter (tab, position, future keys) stays exactly as it arrived. */
export function writeHoldingsFilters(
  params: URLSearchParams,
  filters: HoldingsFilters,
) {
  const put = <T extends string | number>(
    key: string,
    value: T,
    fallback: T,
  ) => {
    const text = String(value);
    if (text === String(fallback)) params.delete(key);
    else params.set(key, text);
  };
  put(holdingsFilterKeys.kind, filters.kind, defaultHoldingsFilters.kind);
  put(
    holdingsFilterKeys.source,
    filters.kind === "real" ? filters.source : "all",
    defaultHoldingsFilters.source,
  );
  put(holdingsFilterKeys.market, filters.market, defaultHoldingsFilters.market);
  put(
    holdingsFilterKeys.stopStatus,
    filters.stopStatus,
    defaultHoldingsFilters.stopStatus,
  );
  put(holdingsFilterKeys.group, filters.group, defaultHoldingsFilters.group);
  put(holdingsFilterKeys.sleeve, filters.sleeve, defaultHoldingsFilters.sleeve);
  put(holdingsFilterKeys.page, filters.page, defaultHoldingsFilters.page);
}

/** `position` undefined keeps whatever the current entry has; null removes it
 *  (the list link); a string opens that position with the same filters. */
export function holdingsHref(
  search: string,
  filters: HoldingsFilters,
  position?: string | null,
) {
  const params = new URLSearchParams(search);
  writeHoldingsFilters(params, filters);
  if (position === null) params.delete("position");
  else if (position !== undefined) params.set("position", position);
  const query = params.toString();
  return `/accounts${query ? `?${query}` : ""}`;
}

/** Only a real cn-equity position whose code is a valid Shanghai/Shenzhen/
 *  Beijing security gets a direct chart link; everything else has no entry. */
export function holdingsChartHref(
  position: Pick<AccountPosition, "market" | "symbol">,
): string | null {
  if (position.market !== "cn-equity") return null;
  return instrumentSchema.safeParse({
    symbol: position.symbol,
    market: "cn-equity",
  }).success
    ? chartSymbolHref(position.symbol)
    : null;
}
