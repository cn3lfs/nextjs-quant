import { expect, it } from "vitest";
import {
  readMarketPoolLocation,
  marketPoolLocationHref,
} from "../../src/lib/market/market-pool-location";
import { poolMembersHref } from "../../src/lib/market/market-pool";

it("reopens all pool filters, table order, page and selection from one URL", () => {
  const location = readMarketPoolLocation(
    "?poolCategory=industry&poolName=电力设备&search=600&period=20&minimumRps=85&sort=symbol&sortColumn=rps&descending=true&page=2&selected=sh600040",
  );
  expect(location).toEqual({
    category: "industry",
    query: {
      pool: { category: "industry", name: "电力设备" },
      search: "600",
      period: 20,
      minimumRps: 85,
      sort: "symbol",
      order: { id: "rps", desc: true },
      page: 2,
      selected: "sh600040",
    },
  });
  const href = marketPoolLocationHref(location);
  expect(href.startsWith("/scan?tab=pool&")).toBe(true);
  expect(readMarketPoolLocation(href.split("?")[1]!)).toEqual(location);
  expect(
    readMarketPoolLocation(
      poolMembersHref("concept", "新能源 & 储能").split("?")[1]!,
    ).query.pool,
  ).toEqual({ category: "concept", name: "新能源 & 储能" });
});

it("rejects malformed fields independently without dropping valid filters", () => {
  const value = readMarketPoolLocation(
    "?poolCategory=other&poolName=../other&search=600&period=999&minimumRps=101&page=-1&sort=invalid&selected=foo",
  );
  expect(value.category).toBe("all");
  expect(value.query).toEqual({
    pool: null,
    search: "600",
    period: 50,
    minimumRps: null,
    page: 0,
    sort: "rps",
    order: null,
    selected: undefined,
  });
  expect(readMarketPoolLocation("?poolCategory=concept").category).toBe(
    "concept",
  );
  expect(readMarketPoolLocation("?poolCategory=concept").query.pool).toBeNull();
  expect(marketPoolLocationHref(readMarketPoolLocation(""))).toBe(
    "/scan?tab=pool",
  );
  expect(readMarketPoolLocation("?minimumRps=").query.minimumRps).toBeNull();
  expect(
    readMarketPoolLocation("?sortColumn=__proto__").query.order,
  ).toBeNull();
  expect(readMarketPoolLocation("?search=平安%20").query.search).toBe("平安 ");
  expect(readMarketPoolLocation("?minimumRps=0&page=0").query.minimumRps).toBe(
    0,
  );
});
