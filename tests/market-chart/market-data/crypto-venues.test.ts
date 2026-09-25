import { afterEach, describe, expect, it } from "vitest";
import {
  candleEnd,
  venueKlines,
} from "../../../src/server/data-sources/crypto-venues/venue-klines";
import {
  bybit,
  coinbase,
  gate,
  okx,
} from "../../../src/server/data-sources/crypto-venues/venues";
import { resetOutboundRoutes } from "../../../src/server/infra/outbound";
import {
  cryptoSourceSchema,
  venueSymbol,
} from "../../../src/lib/market/crypto";

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
/** Direct route only, recording each requested URL. */
const recorder = (reply: (url: URL) => Response) => {
  const urls: URL[] = [];
  return {
    urls,
    options: {
      proxy: "",
      now: () => T0 + 10 * DAY,
      fetcher: async (url: string) => {
        urls.push(new URL(url));
        return reply(new URL(url));
      },
    },
  };
};

afterEach(() => resetOutboundRoutes());

describe("venue symbols and periods", () => {
  it("maps a cx pair to each venue id without swapping the quote asset", () => {
    expect(venueSymbol("okx", "cxBTCUSDT")).toBe("BTC-USDT");
    expect(venueSymbol("gate", "cxETHBTC")).toBe("ETH_BTC");
    expect(venueSymbol("coinbase", "cxSOLUSDT")).toBe("SOL-USDT");
    expect(venueSymbol("bybit", "cxBTCUSDT")).toBe("BTCUSDT");
    expect(venueSymbol("okx", "cxABCDEF")).toBeNull();
    expect(cryptoSourceSchema.options[0]).toBe("auto");
  });
  it("uses UTC day cuts and reports unsupported periods", () => {
    expect(okx.interval("day")).toBe("1Dutc");
    expect(gate.interval("week")).toBeNull();
    expect(coinbase.interval("30m")).toBeNull();
    expect(bybit.interval("month")).toBe("M");
    expect(candleEnd(Date.UTC(2026, 1, 1), "month")).toBe(Date.UTC(2026, 2, 1));
  });
  it("fails clearly for a period the venue lacks, without a request", async () => {
    const r = recorder(() => json([]));
    await expect(
      venueKlines(gate, { symbol: "cxBTCUSDT", period: "week", limit: 10 }, r.options),
    ).rejects.toThrow("不提供该周期");
    expect(r.urls).toHaveLength(0);
  });
});

describe("OKX", () => {
  const candle = (open: number, confirm = "1") => [
    String(open), "100", "102", "99", "101", "5", "500", "505", confirm,
  ];
  it("pages backwards with `after`, merges ascending and marks the forming bar", async () => {
    const r = recorder((url) => {
      const after = url.searchParams.get("after");
      return json({
        code: "0",
        data: after
          ? [candle(T0 + 7 * DAY), candle(T0 + 6 * DAY)]
          : [candle(T0 + 9 * DAY, "0"), candle(T0 + 8 * DAY)],
      });
    });
    const spec = { ...okx, pageSize: 2 };
    const result = await venueKlines(
      spec,
      { symbol: "cxBTCUSDT", period: "day", limit: 4 },
      r.options,
    );
    expect(r.urls[0]!.searchParams.get("bar")).toBe("1Dutc");
    expect(r.urls[1]!.searchParams.get("after")).toBe(String(T0 + 8 * DAY));
    expect(result.bars.map((b) => b.date)).toEqual([
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);
    expect(result.bars[0]).toMatchObject({ open: 100, close: 101, volume: 5, amount: 505 });
    expect(result.formingDates).toEqual(["2026-01-10"]);
    expect(result.source).toBe("okx-spot");
  });
  it("rejects an error body and malformed prices instead of repairing them", async () => {
    await expect(
      venueKlines(okx, { symbol: "cxBTCUSDT", period: "day", limit: 5 },
        recorder(() => json({ code: "51001", msg: "Instrument ID does not exist", data: [] })).options),
    ).rejects.toThrow("Instrument ID does not exist");
    const bad = [String(T0), "100", "90", "99", "101", "5", "500", "505", "1"];
    await expect(
      venueKlines(okx, { symbol: "cxBTCUSDT", period: "day", limit: 5 },
        recorder(() => json({ code: "0", data: [bad] })).options),
    ).rejects.toThrow("价格或时间无效");
  });
});

describe("Gate.io", () => {
  const candle = (open: number, closed = "true") => [
    String(open / 1000), "500", "101", "102", "99", "100", "5", closed,
  ];
  it("reads its column order and ends normally at the 10000-point limit", async () => {
    const r = recorder((url) =>
      url.searchParams.get("to")
        ? json({ label: "INVALID_PARAM_VALUE", message: "Candlestick too long ago. Maximum 10000 points ago are allowed" }, 400)
        : json([candle(T0 + 8 * DAY), candle(T0 + 9 * DAY, "false")]),
    );
    const result = await venueKlines(
      { ...gate, pageSize: 2 },
      { symbol: "cxBTCUSDT", period: "day", limit: 10 },
      r.options,
    );
    expect(r.urls[1]!.searchParams.get("to")).toBe(String((T0 + 8 * DAY) / 1000 - 1));
    expect(result.bars).toHaveLength(2);
    expect(result.bars[1]).toMatchObject({ open: 100, high: 102, low: 99, close: 101, volume: 5, amount: 500 });
    expect(result.historyExhausted).toBe(true);
    expect(result.formingDates).toEqual(["2026-01-10"]);
  });
});

describe("Coinbase", () => {
  it("tiles time windows backwards and keeps paging past a short window", async () => {
    let call = 0;
    const r = recorder(() => {
      call += 1;
      // [time, low, high, open, close, volume], newest first.
      if (call === 1) return json([[ (T0 + 9 * DAY) / 1000, 99, 102, 100, 101, 3 ]]);
      if (call === 2) return json([[ (T0 + 8 * DAY) / 1000, 99, 102, 100, 101, 3 ]]);
      return json([]);
    });
    const result = await venueKlines(
      coinbase,
      { symbol: "cxBTCUSDT", period: "day", limit: 5 },
      r.options,
    );
    expect(r.urls).toHaveLength(3);
    expect(r.urls[1]!.searchParams.get("end")).toBe(
      new Date(T0 + 9 * DAY - 1000).toISOString(),
    );
    expect(result.bars.map((b) => b.date)).toEqual(["2026-01-09", "2026-01-10"]);
    expect(result.bars[0]!.amount).toBe(0);
    expect(result.sourceNote).toContain("不提供成交额");
  });
});

describe("Bybit", () => {
  it("surfaces a region block as an error", async () => {
    await expect(
      venueKlines(bybit, { symbol: "cxBTCUSDT", period: "day", limit: 5 },
        recorder(() => new Response("blocked from your country", { status: 403 })).options),
    ).rejects.toThrow("Bybit HTTP 403");
  });
});
