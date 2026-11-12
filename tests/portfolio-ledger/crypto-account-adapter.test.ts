import { describe, expect, it, vi } from "vitest";
import { SimulatedSpotAdapter } from "../../src/server/crypto-trading/adapter";
import {
  configSchema,
  type Venue,
} from "../../src/server/crypto-trading/model";
const from = 1800000000000,
  to = from + 1000,
  day = 86400000;
const credentials = {
  apiKey: "account-test-key",
  apiSecret: "account-test-secret",
  passphrase: "account-test-passphrase",
};
function fixture(venue: Venue, handler: (url: URL) => unknown) {
  const calls: URL[] = [];
  const adapter = new SimulatedSpotAdapter(
    configSchema.parse({ venue }),
    credentials,
    {
      proxy: "",
      now: () => to + 1000,
      fetcher: async (address) => {
        const url = new URL(address);
        calls.push(url);
        if (url.pathname === "/api/v3/time")
          return Response.json({ serverTime: to + 1000 });
        if (url.pathname === "/api/v5/public/time")
          return Response.json({
            code: "0",
            data: [{ ts: String(to + 1000) }],
          });
        if (url.pathname === "/v5/market/time")
          return Response.json({
            retCode: 0,
            result: { timeSecond: String(Math.floor((to + 1000) / 1000)) },
          });
        const result = handler(url);
        if (result instanceof Response) return result;
        return Response.json(
          venue === "okx"
            ? { code: "0", data: result }
            : venue === "bybit"
              ? { retCode: 0, result }
              : result,
        );
      },
    },
  );
  return { adapter, calls };
}
const binance = (id: string, time = from) => ({
  id,
  orderId: "9007199254740993123",
  symbol: "BTCUSDT",
  isBuyer: true,
  time,
  qty: "0.01",
  price: "50000",
  quoteQty: "500",
  commission: "0.00001",
  commissionAsset: "BTC",
});
const okx = (id: string, time = from) => ({
  tradeId: id,
  billId: id,
  ordId: "9007199254740993123",
  instId: "BTC-USDT",
  instType: "SPOT",
  clOrdId: "outside-client",
  side: "sell",
  fillTime: String(time),
  ts: String(time + 1),
  fillSz: "0.01",
  fillPx: "50000",
  fee: "-0.5",
  feeCcy: "USDT",
});
const bybit = (id: string, time = from) => ({
  execId: id,
  orderId: "outside-order",
  orderLinkId: "outside-client",
  symbol: "BTCUSDT",
  side: "Buy",
  execTime: String(time),
  execQty: "0.01",
  execPrice: "50000",
  execValue: "500",
  execFee: "0.00001",
  feeCurrency: "BTC",
  extraFees: "",
});

describe("account history adapters", () => {
  it("spaces concurrent history calls by 250ms even when the signing clock is frozen", async () => {
    vi.useFakeTimers();
    try {
      const { adapter, calls } = fixture("binance", () => []);
      const first = adapter.tradeHistory("BTCUSDT", from, to);
      const second = adapter.tradeHistory("BTCUSDT", from, to);
      const historyCount = () =>
        calls.filter((url) => url.pathname.endsWith("myTrades")).length;
      await vi.advanceTimersByTimeAsync(0);
      await first;
      expect(historyCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(historyCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(historyCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("releases the history queue after failure and retains request spacing", async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const { adapter, calls } = fixture("binance", () =>
        ++requests === 1 ? Response.json({ code: -2015 }, { status: 401 }) : [],
      );
      const first = adapter.tradeHistory("BTCUSDT", from, to);
      const failed = expect(first).rejects.toThrow("HTTP 401");
      const second = adapter.tradeHistory("BTCUSDT", from, to);
      await vi.advanceTimersByTimeAsync(0);
      await failed;
      expect(requests).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(await second).toEqual([]);
      expect(
        calls.filter((url) => url.pathname.endsWith("myTrades")),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads Binance account-wide trades, preserves IDs and quote values, divides daily windows", async () => {
    const { adapter, calls } = fixture("binance", (url) => [
      binance(
        url.searchParams.get("startTime")!,
        Number(url.searchParams.get("startTime")),
      ),
    ]);
    const result = await adapter.tradeHistory(
      "BTCUSDT",
      from,
      from + day + 1000,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      orderId: "9007199254740993123",
      side: "BUY",
      time: from,
      quoteQuantity: "500",
      feeAsset: "BTC",
    });
    const requests = calls.filter((url) => url.pathname.endsWith("myTrades"));
    expect(requests).toHaveLength(2);
    for (const url of requests) {
      expect(url.searchParams.has("orderId")).toBe(false);
      expect(
        Number(url.searchParams.get("endTime")) -
          Number(url.searchParams.get("startTime")),
      ).toBeLessThan(day);
    }
  });
  it("splits saturated Binance windows without dropping older trades or sharing unsupported parameters", async () => {
    const { adapter, calls } = fixture("binance", (url) => {
      const start = Number(url.searchParams.get("startTime")),
        end = Number(url.searchParams.get("endTime"));
      if (start === from && end === from + 999)
        return Array.from({ length: 1000 }, (_, i) =>
          binance(String(i + 100), from + 600),
        );
      return [binance(String(start), start)];
    });
    expect(await adapter.tradeHistory("BTCUSDT", from, to)).toHaveLength(2);
    expect(
      calls.filter((url) => url.pathname.endsWith("myTrades")),
    ).toHaveLength(3);
  });
  it("paginates more than 1000 Binance fills at one millisecond by ID without time filters", async () => {
    const { adapter, calls } = fixture("binance", (url) => {
      const cursor = url.searchParams.get("fromId");
      if (cursor === null || cursor === "0")
        return Array.from({ length: 1000 }, (_, i) => binance(String(i), from));
      if (cursor === "1000")
        return [binance("1000", from), binance("1001", from + 1)];
      throw new Error("unexpected request");
    });
    const result = await adapter.tradeHistory("BTCUSDT", from, from + 1);
    expect(result).toHaveLength(1001);
    for (const url of calls.filter((url) => url.searchParams.has("fromId"))) {
      expect(url.searchParams.has("startTime")).toBe(false);
      expect(url.searchParams.has("endTime")).toBe(false);
    }
  });
  it("rejects imprecise numeric Binance IDs rather than fabricating their digits", async () => {
    const { adapter } = fixture("binance", () => [
      { ...binance("1"), orderId: Number.MAX_SAFE_INTEGER + 1 },
    ]);
    await expect(adapter.tradeHistory("BTCUSDT", from, to)).rejects.toThrow();
  });
  it("paginates OKX bill IDs and includes execution-time boundary records created later", async () => {
    const { adapter, calls } = fixture("okx", (url) =>
      url.searchParams.has("after")
        ? [{ ...okx("9007199254740993000"), ts: String(to + 200) }]
        : Array.from({ length: 100 }, (_, i) => ({
            ...okx((9007199254740993999n - BigInt(i)).toString()),
            fillTime: String(to + 10),
            ts: String(to + 100),
          })),
    );
    const result = await adapter.tradeHistory("BTCUSDT", from, to);
    expect(calls.some((url) => Number(url.searchParams.get("end")) > to)).toBe(
      true,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      time: from,
      side: "SELL",
      fee: "0.5",
      clientOrderId: "outside-client",
      quoteQuantity: "500",
    });
  });
  it("filters OKX by actual fillTime in [from,to) and handles rebates", async () => {
    const { adapter } = fixture("okx", () => [
      okx("10", from - 1),
      { ...okx("11", from), fee: "0.1" },
      okx("12", to),
    ]);
    const result = await adapter.tradeHistory("BTCUSDT", from, to);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "11", fee: "-0.1" });
  });
  it("rejects repeated OKX cursors instead of reporting complete history", async () => {
    const { adapter } = fixture("okx", () =>
      Array.from({ length: 100 }, (_, i) => okx(String(1000 - i))),
    );
    await expect(adapter.tradeHistory("BTCUSDT", from, to)).rejects.toThrow(
      "分页游标未推进",
    );
  });
  it("paginates Bybit external trades with execTime, deduplicates repeats and uses seven day windows", async () => {
    const { adapter, calls } = fixture("bybit", (url) => ({
      list: [bybit("outside-trade")],
      nextPageCursor: url.searchParams.has("cursor") ? "" : "next",
    }));
    const result = await adapter.tradeHistory("BTCUSDT", from, from + 8 * day);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      time: from,
      clientOrderId: "outside-client",
      quoteQuantity: "500",
      side: "BUY",
    });
    const requests = calls.filter((url) =>
      url.pathname.endsWith("/execution/list"),
    );
    expect(requests).toHaveLength(4);
    for (const url of requests) {
      expect(url.searchParams.has("orderId")).toBe(false);
      expect(url.searchParams.has("orderLinkId")).toBe(false);
      expect(
        Number(url.searchParams.get("endTime")) -
          Number(url.searchParams.get("startTime")),
      ).toBeLessThan(7 * day);
    }
  });
  it("rejects Bybit pagination loops and missing fee currency", async () => {
    const looping = fixture("bybit", () => ({
      list: [bybit("1")],
      nextPageCursor: "repeat",
    }));
    await expect(
      looping.adapter.tradeHistory("BTCUSDT", from, to),
    ).rejects.toThrow("游标重复");
    const invalid = fixture("bybit", () => ({
      list: [{ ...bybit("1"), feeCurrency: "" }],
    }));
    await expect(
      invalid.adapter.tradeHistory("BTCUSDT", from, to),
    ).rejects.toThrow();
  });
  it.each(["binance", "okx", "bybit"] as const)(
    "validates every %s response row including outside-range malformed rows",
    async (venue) => {
      const bad =
        venue === "binance"
          ? { ...binance("1"), commission: "invalid" }
          : venue === "okx"
            ? { ...okx("1", to + 500), fillPx: "invalid" }
            : { ...bybit("1", to + 500), execQty: "invalid" };
      const { adapter } = fixture(venue, () =>
        venue === "bybit" ? { list: [bad] } : [bad],
      );
      await expect(adapter.tradeHistory("BTCUSDT", from, to)).rejects.toThrow();
    },
  );
  it("preserves the same OKX matching trade ID on different own orders", async () => {
    const { adapter } = fixture("okx", () => [
      { ...okx("111"), tradeId: "same-trade" },
      { ...okx("112"), tradeId: "same-trade", ordId: "different-own-order" },
    ]);
    const result = await adapter.tradeHistory("BTCUSDT", from, to);
    expect(result).toHaveLength(2);
    expect(new Set(result.map((trade) => trade.orderId)).size).toBe(2);
    expect(result.every((trade) => trade.id === "same-trade")).toBe(true);
  });
  it("rejects conflicting platform trade IDs and redacts nested raw credentials", async () => {
    const conflicting = fixture("bybit", () => ({
      list: [bybit("same"), { ...bybit("same"), execQty: "0.02" }],
    }));
    await expect(
      conflicting.adapter.tradeHistory("BTCUSDT", from, to),
    ).rejects.toThrow("业务字段冲突");
    const safe = fixture("binance", () => [
      { ...binance("1"), nested: { value: credentials.apiSecret } },
    ]);
    expect(
      JSON.stringify(await safe.adapter.tradeHistory("BTCUSDT", from, to)),
    ).not.toContain(credentials.apiSecret);
  });
  it("rejects invalid or excessive ranges before network IO", async () => {
    const { adapter, calls } = fixture("binance", () => []);
    await expect(adapter.tradeHistory("BTCUSDT", to, from)).rejects.toThrow(
      "时间范围",
    );
    await expect(
      adapter.tradeHistory("BTCUSDT", from, from + 91 * day),
    ).rejects.toThrow("时间范围");
    expect(calls).toEqual([]);
  });
});
