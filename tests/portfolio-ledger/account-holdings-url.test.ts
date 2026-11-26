import { describe, expect, it } from "vitest";
import {
  defaultHoldingsFilters,
  holdingsChartHref,
  holdingsFilterKeys,
  holdingsHref,
  readHoldingsFilters,
  writeHoldingsFilters,
} from "~/lib/portfolio/account-holdings-url";

describe("R2 unified-holdings URL contract", () => {
  it("reads every filter from the holdings keys and falls back inside the server bounds", () => {
    const full = new URLSearchParams({
      [holdingsFilterKeys.kind]: "all",
      [holdingsFilterKeys.source]: "delivery",
      [holdingsFilterKeys.market]: "cn-equity",
      [holdingsFilterKeys.stopStatus]: "touched",
      [holdingsFilterKeys.group]: "sleeve",
      [holdingsFilterKeys.sleeve]: "swing",
      [holdingsFilterKeys.page]: "2",
    });
    expect(readHoldingsFilters(full)).toEqual({
      kind: "all",
      source: "all",
      market: "cn-equity",
      stopStatus: "touched",
      group: "sleeve",
      sleeve: "swing",
      page: 2,
    });

    // Missing and invalid inputs use the same defaults the server applies.
    expect(readHoldingsFilters("")).toEqual(defaultHoldingsFilters);
    expect(
      readHoldingsFilters(
        new URLSearchParams({
          [holdingsFilterKeys.kind]: "broker",
          [holdingsFilterKeys.source]: "broker",
          [holdingsFilterKeys.market]: "options",
          [holdingsFilterKeys.stopStatus]: "above",
          [holdingsFilterKeys.group]: "symbol",
          [holdingsFilterKeys.sleeve]: "s".repeat(101),
          [holdingsFilterKeys.page]: "-1",
        }),
      ),
    ).toEqual(defaultHoldingsFilters);
    expect(
      readHoldingsFilters(
        new URLSearchParams({ [holdingsFilterKeys.market]: "futures" }),
      ).market,
    ).toBe("futures");
    expect(
      readHoldingsFilters(
        new URLSearchParams({ [holdingsFilterKeys.page]: "1.5" }),
      ).page,
    ).toBe(0);
    expect(
      readHoldingsFilters(
        new URLSearchParams({ [holdingsFilterKeys.page]: "1000001" }),
      ).page,
    ).toBe(0);
    expect(
      readHoldingsFilters(
        new URLSearchParams({
          [holdingsFilterKeys.source]: "delivery",
        }),
      ).source,
    ).toBe("delivery");
    // Sources do not exist outside real accounts, even if an old URL carries one.
    expect(
      readHoldingsFilters(
        new URLSearchParams({
          [holdingsFilterKeys.kind]: "paper",
          [holdingsFilterKeys.source]: "delivery",
        }),
      ).source,
    ).toBe("all");
  });

  it("writes only changed holdings keys and leaves unrelated parameters alone", () => {
    const params = new URLSearchParams("tab=trades&position=old&future=1");
    writeHoldingsFilters(params, {
      ...defaultHoldingsFilters,
      kind: "paper",
      source: "delivery",
      group: "kind",
      page: 3,
    });
    expect(params.get("tab")).toBe("trades");
    expect(params.get("position")).toBe("old");
    expect(params.get("future")).toBe("1");
    expect(params.get(holdingsFilterKeys.kind)).toBe("paper");
    expect(params.get(holdingsFilterKeys.source)).toBeNull();
    expect(params.get(holdingsFilterKeys.group)).toBe("kind");
    expect(params.get(holdingsFilterKeys.page)).toBe("3");
    for (const key of [
      holdingsFilterKeys.market,
      holdingsFilterKeys.stopStatus,
      holdingsFilterKeys.sleeve,
    ])
      expect(params.get(key)).toBeNull();
  });

  it("keeps filters in position and list links and emits no parameters at the default", () => {
    expect(holdingsHref("", defaultHoldingsFilters)).toBe("/accounts");
    const filters = {
      ...defaultHoldingsFilters,
      market: "cn-equity" as const,
      group: "sleeve" as const,
      page: 1,
    };
    expect(holdingsHref("position=old", filters, "local:sh600000")).toBe(
      "/accounts?position=local%3Ash600000&holdings_market=cn-equity&holdings_group=sleeve&holdings_page=1",
    );
    expect(holdingsHref("position=old", filters, null)).toBe(
      "/accounts?holdings_market=cn-equity&holdings_group=sleeve&holdings_page=1",
    );
    // A filter-only replace keeps an existing position instead of dropping it.
    expect(holdingsHref("position=old", filters)).toContain("position=old");
  });

  it("links valid Shanghai/Shenzhen/Beijing A-share positions to the chart only", () => {
    expect(holdingsChartHref({ market: "cn-equity", symbol: "sh600519" })).toBe(
      "/scan?symbol=sh600519",
    );
    expect(holdingsChartHref({ market: "cn-equity", symbol: "sz000001" })).toBe(
      "/scan?symbol=sz000001",
    );
    expect(holdingsChartHref({ market: "cn-equity", symbol: "bj430047" })).toBe(
      "/scan?symbol=bj430047",
    );
    expect(
      holdingsChartHref({ market: "crypto", symbol: "cxBTCUSDT" }),
    ).toBeNull();
    expect(
      holdingsChartHref({ market: "cn-equity", symbol: "BTCUSDT" }),
    ).toBeNull();
    expect(
      holdingsChartHref({ market: "cn-equity", symbol: "pt000001" }),
    ).toBeNull();
    expect(
      holdingsChartHref({ market: "cn-equity", symbol: "sh60051" }),
    ).toBeNull();
  });
});
