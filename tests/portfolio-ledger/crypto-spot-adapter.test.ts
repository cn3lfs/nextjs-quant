import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ExchangeError,
  SimulatedSpotAdapter,
} from "../../src/server/crypto-trading/adapter";
import {
  configSchema,
  type Order,
  type Venue,
} from "../../src/server/crypto-trading/model";

const now = 1_800_000_000_000;
const credential = {
  apiKey: "test-key",
  apiSecret: "test-secret",
  passphrase: "test-passphrase",
};
const order: Order = {
  clientId: "cq123",
  symbol: "BTCUSDT",
  side: "BUY",
  quantity: "0.01",
  state: "INTENT",
  fills: [],
};
function fixture(
  venue: Venue,
  handler: (url: URL, init: RequestInit) => unknown,
  network: "demo" | "testnet" = "demo",
) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const adapter = new SimulatedSpotAdapter(
    configSchema.parse({ venue, network }),
    credential,
    {
      proxy: "",
      now: () => now,
      fetcher: async (address, init) => {
        const url = new URL(address);
        calls.push({ url, init });
        if (url.pathname === "/api/v3/time")
          return Response.json({ serverTime: now });
        if (url.pathname === "/api/v5/public/time")
          return Response.json({ code: "0", data: [{ ts: String(now) }] });
        if (url.pathname === "/v5/market/time")
          return Response.json({
            retCode: 0,
            result: { timeSecond: String(now / 1000) },
          });
        const result = handler(url, init);
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

describe("simulated exchange adapters", () => {
  it("signs Binance testnet market orders and never chooses a live private host", async () => {
    const { adapter, calls } = fixture(
      "binance",
      () => ({ orderId: 123, status: "NEW" }),
      "testnet",
    );
    expect(await adapter.place(order)).toMatchObject({ exchangeId: "123" });
    const call = calls.at(-1)!;
    expect(call.url.host).toBe("testnet.binance.vision");
    expect(call.init.method).toBe("POST");
    const query = new URLSearchParams(call.url.search);
    const signature = query.get("signature");
    query.delete("signature");
    expect(signature).toBe(
      createHmac("sha256", credential.apiSecret)
        .update(query.toString())
        .digest("hex"),
    );
    expect(query.get("quantity")).toBe("0.01");
    expect(query.get("type")).toBe("MARKET");
  });
  it("signs OKX exact body with simulated header and base quantity", async () => {
    const { adapter, calls } = fixture("okx", () => [
      { ordId: "123", sCode: "0" },
    ]);
    await adapter.place(order);
    const call = calls.at(-1)!;
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-simulated-trading"]).toBe("1");
    expect(headers["OK-ACCESS-PASSPHRASE"]).toBe(credential.passphrase);
    expect(headers["OK-ACCESS-SIGN"]).toBe(
      createHmac("sha256", credential.apiSecret)
        .update(
          new Date(now).toISOString() +
            "POST/api/v5/trade/order" +
            String(call.init.body),
        )
        .digest("base64"),
    );
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      tdMode: "cash",
      instId: "BTC-USDT",
      tgtCcy: "base_ccy",
      sz: "0.01",
    });
  });
  it("uses Bybit Demo private host and explicit non-leveraged base units", async () => {
    const { adapter, calls } = fixture("bybit", () => ({ orderId: "123" }));
    await adapter.place(order);
    const call = calls.at(-1)!;
    expect(call.url.host).toBe("api-demo.bybit.com");
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      category: "spot",
      marketUnit: "baseCoin",
      isLeverage: 0,
      qty: "0.01",
    });
    const headers = call.init.headers as Record<string, string>;
    expect(headers["X-BAPI-SIGN"]).toBe(
      createHmac("sha256", credential.apiSecret)
        .update(
          String(now) + credential.apiKey + "5000" + String(call.init.body),
        )
        .digest("hex"),
    );
  });
  it("never retries an uncertain write and never exposes credential-bearing exception text", async () => {
    let writes = 0;
    const { adapter } = fixture("binance", () => {
      writes++;
      throw new Error(credential.apiSecret);
    });
    await expect(adapter.place(order)).rejects.toMatchObject({
      outcomeUnknown: true,
      message: "平台请求失败或返回格式无效",
    });
    expect(writes).toBe(1);
  });
  it.each([
    new Response("bad response", { status: 400 }),
    Response.json({ code: -9999 }, { status: 400 }),
    ...[418, 429, 503].map((status) =>
      Response.json(
        {
          code: -2010,
          msg: "Account has insufficient balance for requested action.",
        },
        { status },
      ),
    ),
  ])("keeps ambiguous writes unresolved (%#)", async (response) => {
    const { adapter } = fixture("binance", () => response);
    await expect(adapter.place(order)).rejects.toMatchObject({
      outcomeUnknown: true,
    });
  });
  it("treats Binance HTTP400 timeout as an uncertain submission", async () => {
    const { adapter } = fixture("binance", () =>
      Response.json({ code: -1007 }, { status: 400 }),
    );
    await expect(adapter.place(order)).rejects.toMatchObject({
      outcomeUnknown: true,
      code: "-1007",
    });
  });
  it.each(["binance", "okx", "bybit"] as const)(
    "caps %s market buys in quote currency and keeps sells in base units",
    async (venue) => {
      const { adapter, calls } = fixture(venue, () =>
        venue === "okx" ? [{ ordId: "123", sCode: "0" }] : { orderId: "123" },
      );
      await adapter.place({ ...order, quoteBudget: "399.99" });
      const buy = calls.at(-1)!;
      if (venue === "binance") {
        expect(buy.url.searchParams.get("quoteOrderQty")).toBe("399.99");
        expect(buy.url.searchParams.has("quantity")).toBe(false);
      } else {
        const body = JSON.parse(String(buy.init.body)) as Record<
          string,
          unknown
        >;
        expect(body[venue === "okx" ? "sz" : "qty"]).toBe("399.99");
        expect(body[venue === "okx" ? "tgtCcy" : "marketUnit"]).toBe(
          venue === "okx" ? "quote_ccy" : "quoteCoin",
        );
      }
      await adapter.place({ ...order, side: "SELL" });
      const sell = calls.at(-1)!;
      if (venue === "binance") {
        expect(sell.url.searchParams.get("quantity")).toBe(order.quantity);
        expect(sell.url.searchParams.has("quoteOrderQty")).toBe(false);
      } else {
        const body = JSON.parse(String(sell.init.body)) as Record<
          string,
          unknown
        >;
        expect(body[venue === "okx" ? "sz" : "qty"]).toBe(order.quantity);
        expect(body[venue === "okx" ? "tgtCcy" : "marketUnit"]).toBe(
          venue === "okx" ? "base_ccy" : "baseCoin",
        );
      }
      await expect(
        adapter.place({ ...order, side: "SELL", quoteBudget: "399.99" }),
      ).rejects.toMatchObject({ outcomeUnknown: false });
      await expect(
        adapter.place({ ...order, quoteBudget: "0" }),
      ).rejects.toThrow();
    },
  );
  it("distinguishes Binance insufficient balance rejection from duplicate client id", async () => {
    const insufficient = fixture("binance", () =>
      Response.json(
        {
          code: -2010,
          msg: "Account has insufficient balance for requested action.",
        },
        { status: 400 },
      ),
    );
    await expect(insufficient.adapter.place(order)).rejects.toMatchObject({
      outcomeUnknown: false,
      code: "-2010",
    });
    const duplicate = fixture("binance", () =>
      Response.json(
        { code: -2010, msg: "Duplicate order sent. " + credential.apiSecret },
        { status: 400 },
      ),
    );
    const result = await duplicate.adapter
      .place(order)
      .catch((error) => error as ExchangeError);
    expect(result).toMatchObject({ outcomeUnknown: true, code: "-2010" });
    expect((result as ExchangeError).message).not.toContain(
      credential.apiSecret,
    );
  });
  it.each([
    { code: "0", data: [{ sCode: "99999", ordId: "" }] },
    { code: "1", data: [{ sCode: "51011", ordId: "" }] },
    {
      code: "0",
      data: [
        { sCode: "51008", ordId: "" },
        { sCode: "0", ordId: "123" },
      ],
    },
  ])(
    "keeps ambiguous OKX order responses unresolved (%#)",
    async (envelope) => {
      const { adapter } = fixture("okx", () => Response.json(envelope));
      await expect(adapter.place(order)).rejects.toMatchObject({
        outcomeUnknown: true,
      });
    },
  );
  it("checks OKX per-order business result even on HTTP success", async () => {
    const { adapter } = fixture("okx", () => [{ ordId: "", sCode: "51008" }]);
    await expect(adapter.place(order)).rejects.toMatchObject({
      outcomeUnknown: false,
      code: "51008",
    });
  });
  it("applies Binance market and regular lot intersection and market notional flags", async () => {
    const { adapter } = fixture("binance", () => ({
      symbols: [
        {
          symbol: "BTCUSDT",
          status: "TRADING",
          filters: [
            {
              filterType: "LOT_SIZE",
              minQty: "0.001",
              maxQty: "100",
              stepSize: "0.002",
            },
            {
              filterType: "MARKET_LOT_SIZE",
              minQty: "0",
              maxQty: "50",
              stepSize: "0.003",
            },
            {
              filterType: "NOTIONAL",
              minNotional: "10",
              maxNotional: "5000",
              applyMinToMarket: false,
              applyMaxToMarket: true,
            },
          ],
        },
      ],
    }));
    expect(await adapter.rules("BTCUSDT")).toEqual({
      step: "0.006",
      min: "0.001",
      max: "50",
      minValue: "0",
      maxValue: "5000",
    });
  });
  it("uses current Bybit market size and base precision fields", async () => {
    const { adapter } = fixture("bybit", () => ({
      list: [
        {
          symbol: "BTCUSDT",
          status: "Trading",
          lotSizeFilter: {
            basePrecision: "0.000001",
            maxMarketOrderQty: "41.5",
            minOrderAmt: "5",
          },
        },
      ],
    }));
    expect(await adapter.rules("BTCUSDT")).toEqual({
      step: "0.000001",
      min: "0",
      max: "41.5",
      minValue: "5",
    });
  });
  it("filters Bybit open candle and uses public mainnet market source", async () => {
    const duration = 60 * 60_000;
    const start = Math.floor(now / duration) * duration;
    const { adapter, calls } = fixture("bybit", () => ({
      list: [
        [String(start), "1", "1", "1", "2", "1", "1"],
        [String(start - duration), "1", "1", "1", "1", "1", "1"],
      ],
    }));
    expect(await adapter.candles("BTCUSDT", 60, 2)).toEqual([
      { time: start - duration, close: 1 },
    ]);
    expect(calls.at(-1)!.url.host).toBe("api.bybit.com");
  });
  it("rejects duplicate candle timestamps", async () => {
    const { adapter } = fixture("okx", () => [
      [String(now - 3600000), "1", "1", "1", "2", "1", "1", "1", "1"],
      [String(now - 3600000), "1", "1", "1", "2", "1", "1", "1", "1"],
    ]);
    await expect(adapter.candles("BTCUSDT", 60, 2)).rejects.toThrow(
      "重复或缺口",
    );
  });
  it("deduplicates OKX fills and normalizes charged base fees positive", async () => {
    const trade = {
      tradeId: "55",
      ordId: "123",
      fillSz: "0.01",
      fillPx: "50000",
      fee: "-0.00001",
      feeCcy: "BTC",
    };
    const { adapter } = fixture("okx", (url) =>
      url.pathname.endsWith("/order")
        ? [
            {
              ordId: "123",
              state: "filled",
              accFillSz: "0.01",
              clOrdId: order.clientId,
              instId: "BTC-USDT",
              side: "buy",
            },
          ]
        : [trade, trade],
    );
    expect(await adapter.reconcile(order)).toMatchObject({
      state: "filled",
      executedQuantity: "0.01",
      fills: [{ quantity: "0.01", fee: "0.00001", feeAsset: "BTC" }],
    });
  });
  it("refuses terminal orders with incomplete trades instead of releasing their funds", async () => {
    const { adapter } = fixture("binance", (url) =>
      url.pathname.endsWith("/order")
        ? {
            orderId: 123,
            status: "FILLED",
            executedQty: "0.01",
            clientOrderId: order.clientId,
            symbol: order.symbol,
            side: order.side,
          }
        : [],
    );
    await expect(adapter.reconcile(order)).rejects.toThrow(
      "累计成交与成交明细不一致",
    );
  });
  it("uses documented not-found result only and preserves unknown lookups", async () => {
    const missing = fixture("binance", () =>
      Response.json({ code: -2013 }, { status: 400 }),
    );
    expect(await missing.adapter.reconcile(order)).toBeNull();
    const forbidden = fixture("binance", () =>
      Response.json({ code: -2015 }, { status: 401 }),
    );
    await expect(forbidden.adapter.reconcile(order)).rejects.toBeInstanceOf(
      ExchangeError,
    );
  });
  it("paginates Bybit executions until cursor exhaustion and refuses missing fee currency", async () => {
    let pages = 0;
    const { adapter } = fixture("bybit", (url) => {
      if (url.pathname.includes("/order/"))
        return {
          list: [
            {
              orderId: "123",
              orderStatus: "Filled",
              cumExecQty: "0.01",
              orderLinkId: order.clientId,
              symbol: order.symbol,
              side: "Buy",
            },
          ],
        };
      pages++;
      return {
        list: [
          {
            execId: String(pages),
            orderId: "123",
            execQty: "0.005",
            execPrice: "50000",
            execFee: "0.01",
            feeCurrency: "USDT",
          },
        ],
        nextPageCursor: pages === 1 ? "next" : "",
      };
    });
    expect((await adapter.reconcile(order))?.fills).toHaveLength(2);
    expect(pages).toBe(2);
    const invalid = fixture("bybit", (url) =>
      url.pathname.includes("/order/")
        ? {
            list: [
              {
                orderId: "123",
                orderStatus: "Filled",
                cumExecQty: "0.01",
                orderLinkId: order.clientId,
                symbol: order.symbol,
                side: "Buy",
              },
            ],
          }
        : {
            list: [
              {
                execId: "1",
                orderId: "123",
                execQty: "0.01",
                execPrice: "50000",
                execFee: "0.01",
              },
            ],
          },
    );
    await expect(invalid.adapter.reconcile(order)).rejects.toThrow();
  });
  it("redacts secrets echoed in successful raw responses", async () => {
    const { adapter } = fixture("binance", () => ({
      orderId: 123,
      nested: { echo: credential.apiSecret },
    }));
    expect(JSON.stringify((await adapter.place(order)).raw)).not.toContain(
      credential.apiSecret,
    );
  });
});
