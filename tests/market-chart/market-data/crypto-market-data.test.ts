import { afterEach, describe, expect, it } from "vitest";
import {
  binanceKlines,
  mergeKlinePages,
  parseBinanceKlines,
} from "../../../src/server/data-sources/binance/binance-klines";
import {
  outboundFetch,
  resetOutboundRoutes,
} from "../../../src/server/infra/outbound";
import {
  chartSymbolSchema,
  isNonAShareChartSymbol,
  normalizeChartSymbol,
  chartPricePrecision,
  chartSymbolHref,
} from "../../../src/lib/chart/chart-symbol";
import {
  binanceInterval,
  cryptoAssets,
  cryptoBarDate,
} from "../../../src/lib/market/crypto";
import { symbolSchema } from "../../../src/lib/domain";

const DAY = 86400000;
const row = (open: number, price = 100, span = DAY) => [
  open,
  String(price),
  String(price + 2),
  String(price - 1),
  String(price + 1),
  "12.5",
  open + span - 1,
  "1250",
  10,
  "1",
  "1",
  "0",
];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

afterEach(() => resetOutboundRoutes());

describe("crypto symbols stay apart from A-share codes", () => {
  it("accepts cx pairs in charts only and bypasses A-share paths", () => {
    expect(chartSymbolSchema.safeParse("cxBTCUSDT").success).toBe(true);
    expect(chartSymbolSchema.safeParse("cxBT").success).toBe(false);
    expect(symbolSchema.safeParse("cxBTCUSDT").success).toBe(false);
    expect(isNonAShareChartSymbol("cxETHUSDT")).toBe(true);
    expect(isNonAShareChartSymbol("sh600519")).toBe(false);
    expect(cryptoAssets("cxETHUSDT")).toEqual({ base: "ETH", quote: "USDT" });
  });

  it("maps every chart period to a native Binance interval", () => {
    expect(binanceInterval).toMatchObject({
      "60m": "1h",
      day: "1d",
      week: "1w",
      month: "1M",
    });
  });

  it("labels daily bars by UTC open date and intraday bars by UTC end", () => {
    const open = Date.UTC(2026, 8, 23, 16, 40);
    expect(cryptoBarDate(open, open + 300000 - 1, "5m")).toBe(
      "2026-09-23T16:45:00+00:00",
    );
    expect(
      cryptoBarDate(Date.UTC(2026, 8, 23), Date.UTC(2026, 8, 24) - 1, "day"),
    ).toBe("2026-09-23");
  });

  it("scales price precision with the quote level", () => {
    expect(chartPricePrecision("cxBTCUSDT", 84000)).toBe(2);
    expect(chartPricePrecision("cxXRPUSDT", 2.3)).toBe(4);
    expect(chartPricePrecision("cxDOGEUSDT", 0.12)).toBe(6);
    expect(chartPricePrecision("sh600519")).toBe(2);
  });

  it("keeps crypto out of A-share chart parsing and links to its own page", () => {
    expect(normalizeChartSymbol("cxbtcusdt")).toBeNull();
    expect(normalizeChartSymbol("sh600519")).toBe("sh600519");
    expect(chartSymbolHref("cxETHUSDT")).toBe("/crypto?pair=ETHUSDT");
    expect(chartSymbolHref("sh600519")).toBe("/market?symbol=sh600519");
  });
});

describe("Binance klines", () => {
  it("rejects malformed or inconsistent rows instead of repairing them", () => {
    expect(() => parseBinanceKlines({ code: -1121 }, "day")).toThrow();
    const bad = row(0);
    bad[2] = "50";
    expect(() => parseBinanceKlines([bad], "day")).toThrow("价格或时间无效");
  });

  it("merges newest-first pages into one ascending series without duplicates", () => {
    const older = parseBinanceKlines([row(0), row(DAY)], "day");
    const newer = parseBinanceKlines([row(DAY), row(2 * DAY)], "day");
    expect(mergeKlinePages([newer, older]).map((r) => r.openTime)).toEqual([
      0,
      DAY,
      2 * DAY,
    ]);
  });

  it("pages backwards with endTime and marks the forming bar", async () => {
    const urls: URL[] = [];
    const start = Date.UTC(2026, 0, 1);
    const fetcher = async (url: string) => {
      const u = new URL(url);
      urls.push(u);
      const limit = Number(u.searchParams.get("limit"));
      const end = Number(u.searchParams.get("endTime") ?? start + 1500 * DAY);
      const rows = [];
      for (let i = limit; i > 0; i--) rows.push(row(end - i * DAY + 1));
      return json(rows);
    };
    const now = start + 1499.5 * DAY;
    const result = await binanceKlines(
      { symbol: "cxBTCUSDT", period: "day", limit: 1500 },
      { fetcher, proxy: "", now: () => now },
    );
    expect(urls.map((u) => u.searchParams.get("limit"))).toEqual([
      "1000",
      "500",
    ]);
    // First page: the newest 1000 bars; the next page ends before its oldest.
    expect(urls[0]!.searchParams.has("endTime")).toBe(false);
    expect(urls[1]!.searchParams.get("endTime")).toBe(
      String(start + 500 * DAY),
    );
    expect(urls[0]!.searchParams.get("interval")).toBe("1d");
    expect(urls[0]!.searchParams.get("symbol")).toBe("BTCUSDT");
    expect(result.bars).toHaveLength(1500);
    expect(result.bars[0]!.date < result.bars.at(-1)!.date).toBe(true);
    expect(result.sourceNote).toContain("data-api.binance.vision 直连");
    expect(result.formingDates.length).toBeLessThanOrEqual(1);
  });

  it("falls through to the next host and reports both failures", async () => {
    const fetcher = async (url: string) =>
      new URL(url).host === "data-api.binance.vision"
        ? json({ code: -1121, msg: "Invalid symbol." }, 400)
        : json({ code: 0, msg: "restricted location" }, 451);
    await expect(
      binanceKlines(
        { symbol: "cxNOPEUSDT", period: "day", limit: 10 },
        { fetcher, proxy: "" },
      ),
    ).rejects.toThrow(
      /data-api\.binance\.vision：币安 HTTP 400.*api\.binance\.com：币安 HTTP 451/,
    );
  });
});

describe("outbound route: direct first, proxy as fallback", () => {
  it("uses the proxy only after the direct route fails, then remembers it", async () => {
    const calls: string[] = [];
    let clock = 0;
    const fetcher = async (_: string, init: { dispatcher?: unknown }) => {
      calls.push(init.dispatcher ? "proxy" : "direct");
      if (!init.dispatcher) throw new TypeError("fetch failed");
      return json({ ok: true });
    };
    const options = {
      fetcher,
      proxy: "socks5://127.0.0.1:10808",
      now: () => clock,
    };
    expect((await outboundFetch("https://x.test/a", {}, options)).route).toBe(
      "proxy",
    );
    expect((await outboundFetch("https://x.test/b", {}, options)).route).toBe(
      "proxy",
    );
    expect(calls).toEqual(["direct", "proxy", "proxy"]);
    clock = 11 * 60000;
    await outboundFetch("https://x.test/c", {}, options);
    expect(calls.slice(3)).toEqual(["direct", "proxy"]);
  });

  it("stays direct when direct works and does not use a proxy when none is set", async () => {
    const calls: string[] = [];
    const fetcher = async (_: string, init: { dispatcher?: unknown }) => {
      calls.push(init.dispatcher ? "proxy" : "direct");
      return json({});
    };
    expect(
      (
        await outboundFetch(
          "https://y.test/",
          {},
          { fetcher, proxy: "socks5://127.0.0.1:1" },
        )
      ).route,
    ).toBe("direct");
    expect(calls).toEqual(["direct"]);
    await expect(
      outboundFetch(
        "https://z.test/",
        {},
        {
          fetcher: async () => Promise.reject(new TypeError("fetch failed")),
          proxy: "",
        },
      ),
    ).rejects.toThrow("fetch failed");
  });

  it("times out a hanging direct attempt quickly and switches to the proxy", async () => {
    const fetcher = (
      _: string,
      init: { dispatcher?: unknown; signal?: AbortSignal | null },
    ) =>
      init.dispatcher
        ? Promise.resolve(json({}))
        : new Promise<Response>((_, reject) =>
            init.signal?.addEventListener("abort", () =>
              reject(init.signal!.reason),
            ),
          );
    const started = Date.now();
    const result = await outboundFetch(
      "https://slow.test/",
      {},
      { fetcher, proxy: "socks5://127.0.0.1:10808", directTimeoutMs: 50 },
    );
    expect(result.route).toBe("proxy");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
