import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseYahooChart } from "../../../src/server/data-sources/yahoo/yahoo-futures";
import { futuresContracts } from "../../../src/lib/market/futures";

const chart = (
  timestamp: number[],
  rows: (number | null)[][],
  symbol = "GC=F",
) => ({
  chart: {
    result: [
      {
        meta: {
          symbol,
          gmtoffset: -14400,
          regularMarketPrice: 4324.5,
          regularMarketChangePercent: 0.141,
          regularMarketTime: 1790225794,
        },
        timestamp,
        indicators: {
          quote: [
            {
              open: rows.map((r) => r[0]!),
              high: rows.map((r) => r[1]!),
              low: rows.map((r) => r[2]!),
              close: rows.map((r) => r[3]!),
              volume: rows.map((r) => r[4]!),
            },
          ],
        },
      },
    ],
  },
});
// 2026-09-23 00:00 and 2026-09-24 00:00 New York (04:00 UTC).
const D1 = Date.UTC(2026, 8, 23, 4) / 1000;
const D2 = Date.UTC(2026, 8, 24, 4) / 1000;

describe("Yahoo futures chart", () => {
  it("labels daily bars by exchange trade date and marks the forming bar", () => {
    const parsed = parseYahooChart(
      chart(
        [D1, D2],
        [
          [4394.7, 4407.5, 4310.7, 4322.7, 140658],
          [4324.4, 4338, 4308, 4324.5, 31310],
        ],
      ),
      "GC=F",
      "day",
      (D2 + 3600) * 1000,
    );
    expect(parsed.bars.map((b) => b.date)).toEqual([
      "2026-09-23",
      "2026-09-24",
    ]);
    expect(parsed.formingDates).toEqual(["2026-09-24"]);
    expect(parsed.quote).toEqual({
      close: 4324.5,
      changePct: 0.141,
      time: 1790225794000,
    });
  });

  it("labels minute bars by Beijing end time and drops null padding silently", () => {
    const t = Date.UTC(2026, 8, 24, 3, 0) / 1000; // 11:00 Beijing
    const parsed = parseYahooChart(
      chart(
        [t, t + 300],
        [
          [91.3, 91.5, 91.2, 91.4, 100],
          [null, null, null, null, null],
        ],
        "CL=F",
      ),
      "CL=F",
      "5m",
      0,
    );
    expect(parsed.bars.map((b) => b.date)).toEqual([
      "2026-09-24T11:05:00+08:00",
    ]);
    expect(parsed.excluded).toEqual([]);
  });

  it("lists null and inconsistent daily rows instead of repairing them", () => {
    const parsed = parseYahooChart(
      chart(
        [D1 - 86400, D1, D2],
        [
          [null, null, null, null, 0],
          [98.36, 98.09, 97.09, 97.23, 1],
          [98, 99, 97, 98.5, 1],
        ],
      ),
      "GC=F",
      "day",
      0,
    );
    expect(parsed.bars.map((b) => b.date)).toEqual(["2026-09-24"]);
    expect(parsed.excluded.map((e) => e.reason)).toEqual([
      "Yahoo 空行",
      "Yahoo OHLC 不自洽",
    ]);
  });

  it("rejects errors, empty results and mismatched symbols", () => {
    expect(() =>
      parseYahooChart(
        { chart: { result: null, error: { code: "Not Found" } } },
        "GC=F",
        "day",
      ),
    ).toThrow("未返回有效");
    expect(() =>
      parseYahooChart(chart([D1], [[1, 1, 1, 1, 1]], "SI=F"), "GC=F", "day"),
    ).toThrow("不匹配");
    expect(() =>
      parseYahooChart(
        chart([D1], [[null, null, null, null, null]]),
        "GC=F",
        "day",
      ),
    ).toThrow("没有有效");
  });

  it("maps every foreign contract to Yahoo and keeps domestic ones off it", () => {
    const yahoo = futuresContracts.filter((c) => c.yahoo).map((c) => c.symbol);
    expect(yahoo).toEqual([
      "fuGC00Y",
      "fuSI00Y",
      "fuHG00Y",
      "fuALI",
      "fuCL00Y",
      "fuB00Y",
    ]);
    for (const c of futuresContracts) expect(!!c.yahoo || !!c.secid).toBe(true);
  });
});

const mocks = vi.hoisted(() => ({
  yahoo: vi.fn(),
  eastmoney: vi.fn(),
  sina: vi.fn(),
}));
vi.mock(
  "../../../src/server/data-sources/yahoo/yahoo-futures",
  async (orig) => ({
    ...(await orig<object>()),
    yahooFuturesKlines: mocks.yahoo,
  }),
);
vi.mock(
  "../../../src/server/data-sources/eastmoney/eastmoney-futures",
  async (orig) => ({
    ...(await orig<object>()),
    eastmoneyFuturesKlines: mocks.eastmoney,
  }),
);
vi.mock("../../../src/server/data-sources/sina/sina-futures", async (orig) => ({
  ...(await orig<object>()),
  sinaFuturesDaily: mocks.sina,
}));

const ok = (source: string) => ({
  version: `${source}-1`,
  source,
  sourceUrl: "x",
  bars: [
    {
      date: "2026-09-24",
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 0,
      amount: 0,
    },
  ],
  excluded: [],
  formingDates: [],
  historyExhausted: true,
  sourceNote: source,
});

describe("futures source chain", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of Object.values(mocks)) m.mockReset();
  });
  const load = async () =>
    (await import("../../../src/server/market/futures-chart")).futuresKlines;

  it("uses Yahoo first for foreign contracts", async () => {
    mocks.yahoo.mockResolvedValue(ok("yahoo-futures"));
    const result = await (await load())("fuGC00Y", "day", 100);
    expect(result.source).toBe("yahoo-futures");
    expect(mocks.eastmoney).not.toHaveBeenCalled();
  });

  it("falls through Yahoo → Eastmoney → Sina and records each failure", async () => {
    mocks.yahoo.mockRejectedValue(new Error("Yahoo HTTP 429"));
    mocks.eastmoney.mockRejectedValue(new Error("fetch failed"));
    mocks.sina.mockResolvedValue({
      ...ok("sina-futures"),
      version: "sina-futures-1",
    });
    const futuresKlines = await load();
    const result = await futuresKlines("fuCL00Y", "day", 100);
    expect(result.source).toBe("sina-futures");
    expect(result.sourceErrors).toEqual([
      "Yahoo：Yahoo HTTP 429",
      "东方财富：fetch failed",
    ]);
    // Within the backoff both failed sources are skipped without a request.
    mocks.yahoo.mockClear();
    mocks.eastmoney.mockClear();
    await futuresKlines("fuGC00Y", "day", 100);
    expect(mocks.yahoo).not.toHaveBeenCalled();
    expect(mocks.eastmoney).not.toHaveBeenCalled();
  });

  it("never skips the last usable source and has no Sina for minute bars", async () => {
    mocks.eastmoney.mockRejectedValueOnce(new Error("fetch failed"));
    const futuresKlines = await load();
    await expect(futuresKlines("fuAUM", "5m", 100)).rejects.toThrow(
      "东方财富：fetch failed",
    );
    mocks.eastmoney.mockResolvedValue(ok("eastmoney-futures"));
    expect((await futuresKlines("fuAUM", "5m", 100)).source).toBe(
      "eastmoney-futures",
    );
    expect(mocks.sina).not.toHaveBeenCalled();
    mocks.yahoo.mockRejectedValue(new Error("down"));
    await expect(futuresKlines("fuALI", "day", 100)).rejects.toThrow(
      "Yahoo：down",
    );
  });

  it("runs only the manually picked source, with no fallback", async () => {
    mocks.yahoo.mockResolvedValue(ok("yahoo-futures"));
    mocks.eastmoney.mockRejectedValue(new Error("fetch failed"));
    const futuresKlines = await load();
    await expect(
      futuresKlines("fuGC00Y", "day", 100, "eastmoney"),
    ).rejects.toThrow("fetch failed");
    expect(mocks.yahoo).not.toHaveBeenCalled();
    await expect(futuresKlines("fuAUM", "day", 100, "yahoo")).rejects.toThrow(
      "不支持",
    );
    await expect(futuresKlines("fuGC00Y", "5m", 100, "sina")).rejects.toThrow(
      "不支持",
    );
    mocks.sina.mockResolvedValue(ok("sina-futures"));
    expect((await futuresKlines("fuGC00Y", "day", 100, "sina")).source).toBe(
      "sina-futures",
    );
  });
});

describe("outbound proxyOnStatus", () => {
  it("retries a geo-blocked direct response through the proxy", async () => {
    const { outboundFetch, resetOutboundRoutes } = await vi.importActual<
      typeof import("../../../src/server/infra/outbound")
    >("../../../src/server/infra/outbound");
    resetOutboundRoutes();
    const calls: string[] = [];
    const fetcher = async (_url: string, init: { dispatcher?: unknown }) => {
      calls.push(init.dispatcher ? "proxy" : "direct");
      return new Response("x", { status: init.dispatcher ? 200 : 403 });
    };
    const result = await outboundFetch(
      "https://blocked.example/x",
      {},
      { fetcher, proxy: "socks5://127.0.0.1:10808", proxyOnStatus: [403] },
    );
    expect(calls).toEqual(["direct", "proxy"]);
    expect(result.route).toBe("proxy");
    // Without the option a 403 is returned as-is.
    resetOutboundRoutes();
    const plain = await outboundFetch(
      "https://blocked.example/x",
      {},
      { fetcher, proxy: "socks5://127.0.0.1:10808" },
    );
    expect(plain.response.status).toBe(403);
  });
});
