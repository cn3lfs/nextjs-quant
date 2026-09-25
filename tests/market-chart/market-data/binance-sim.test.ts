import { afterEach, describe, expect, it } from "vitest";
import {
  BinanceSimClient,
  binanceSignature,
  binanceSimNetworks,
  type BinanceCallEvidence,
} from "../../../src/server/data-sources/binance/binance-private";
import {
  cryptoDemoOrderSchema,
  onStep,
  orderProblems,
} from "../../../src/server/portfolio/crypto-demo-service";
import { resetOutboundRoutes } from "../../../src/server/infra/outbound";

afterEach(() => resetOutboundRoutes());
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const credential = {
  apiKey: "KEYKEYKEYKEYKEYKEY1234",
  apiSecret: "SECRETSECRETSECRET5678",
  network: "testnet" as const,
};

describe("Binance signing", () => {
  it("matches the official HMAC-SHA256 example", () => {
    // developers.binance.com SIGNED endpoint example (HMAC).
    expect(
      binanceSignature(
        "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559",
        "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j",
      ),
    ).toBe("c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71");
  });
  it("only knows the two simulated hosts", () => {
    expect(Object.values(binanceSimNetworks)).toEqual([
      "https://demo-api.binance.com",
      "https://testnet.binance.vision",
    ]);
  });
});

describe("simulated client", () => {
  const setup = (reply: (url: URL, init: RequestInit) => Response | Promise<Response>) => {
    const calls: { url: URL; init: RequestInit; via: string }[] = [];
    const evidence: BinanceCallEvidence[] = [];
    const c = new BinanceSimClient(credential, (e) => evidence.push(e), {
      proxy: "socks5h://127.0.0.1:1",
      now: () => 1_000_000,
      fetcher: async (url, init) => {
        const via = (init as { dispatcher?: unknown }).dispatcher ? "proxy" : "direct";
        calls.push({ url: new URL(url), init, via });
        return reply(new URL(url), init);
      },
    });
    return { c, calls, evidence };
  };
  it("syncs the clock, signs requests, sends the key header and redacts evidence", async () => {
    const { c, calls, evidence } = setup((url) =>
      url.pathname === "/api/v3/time"
        ? json({ serverTime: 1_000_500 })
        : json({ balances: [], echo: credential.apiKey }),
    );
    await c.account();
    const signed = calls[1]!;
    expect(signed.url.host).toBe("testnet.binance.vision");
    expect(signed.url.searchParams.get("timestamp")).toBe("1000500");
    const query = new URLSearchParams(signed.url.search);
    const signature = query.get("signature")!;
    query.delete("signature");
    expect(signature).toBe(binanceSignature(query.toString(), credential.apiSecret));
    expect((signed.init.headers as Record<string, string>)["X-MBX-APIKEY"]).toBe(credential.apiKey);
    expect(JSON.stringify(evidence)).not.toContain(credential.apiKey);
    expect(JSON.stringify(evidence)).not.toContain(signature);
  });
  it("never re-sends an order over the proxy after a direct failure; outcome is unknown", async () => {
    const { c, calls } = setup((url) => {
      if (url.pathname === "/api/v3/time") return json({ serverTime: 1_000_000 });
      throw new Error("socket hang up");
    });
    await expect(
      c.newOrder({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.001", price: "1000", clientOrderId: "abc" }),
    ).rejects.toMatchObject({ outcomeUnknown: true });
    const orders = calls.filter((x) => x.url.pathname === "/api/v3/order");
    expect(orders).toHaveLength(1);
    expect(orders[0]!.init.method).toBe("POST");
  });
  it("reports an exchange rejection as known, with Binance's message", async () => {
    const { c } = setup((url) =>
      url.pathname === "/api/v3/time"
        ? json({ serverTime: 1_000_000 })
        : json({ code: -2010, msg: "Account has insufficient balance" }, 400),
    );
    await expect(
      c.newOrder({ symbol: "BTCUSDT", side: "BUY", type: "MARKET", quantity: "1", clientOrderId: "abc" }),
    ).rejects.toMatchObject({ outcomeUnknown: false, message: "币安 -2010：Account has insufficient balance" });
  });
});

describe("order checks", () => {
  const info = {
    symbol: "BTCUSDT",
    status: "TRADING",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    filters: [
      { filterType: "PRICE_FILTER", minPrice: "0.01", maxPrice: "1000000", tickSize: "0.01" },
      { filterType: "LOT_SIZE", minQty: "0.00001", maxQty: "9000", stepSize: "0.00001" },
      { filterType: "NOTIONAL", minNotional: "5" },
    ],
  };
  it("checks step multiples exactly with decimal strings", () => {
    expect(onStep("0.00030", "0.00001")).toBe(true);
    expect(onStep("0.000305", "0.00001")).toBe(false);
    expect(onStep("84000.1", "0.01")).toBe(true);
    expect(onStep("84000.123", "0.01")).toBe(false);
  });
  it("lists every violated exchange filter", () => {
    const order = cryptoDemoOrderSchema.parse({
      symbol: "cxBTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.000001", price: "84000.005",
    });
    expect(orderProblems(order, info, 84000).problems).toEqual([
      "数量低于最小 0.00001",
      "数量须为 0.00001 的整数倍",
      "价格须为 0.01 的整数倍",
      expect.stringContaining("名义金额"),
    ]);
    const ok = cryptoDemoOrderSchema.parse({
      symbol: "cxBTCUSDT", side: "BUY", type: "MARKET", quantity: "0.001",
    });
    expect(orderProblems(ok, info, 84000)).toEqual({ problems: [], notional: 84 });
  });
  it("requires a price for limit orders and rejects unknown fields", () => {
    expect(cryptoDemoOrderSchema.safeParse({ symbol: "cxBTCUSDT", side: "BUY", type: "LIMIT", quantity: "1" }).success).toBe(false);
    expect(cryptoDemoOrderSchema.safeParse({ symbol: "cxBTCUSDT", side: "BUY", type: "MARKET", quantity: "1", live: true }).success).toBe(false);
  });
});
