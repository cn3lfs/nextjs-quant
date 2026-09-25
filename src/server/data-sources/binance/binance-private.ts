import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  outboundFetch,
  type OutboundOptions,
} from "../../infra/outbound";

/**
 * Signed Binance Spot REST client for simulated trading only. The host comes
 * from a fixed map of the two simulated networks; there is no live host, so a
 * key can never reach the real exchange through this client.
 */
export const binanceSimNetworks = {
  demo: "https://demo-api.binance.com",
  testnet: "https://testnet.binance.vision",
} as const;
export type BinanceSimNetwork = keyof typeof binanceSimNetworks;

export type BinanceSimCredential = {
  apiKey: string;
  apiSecret: string;
  network: BinanceSimNetwork;
};
export type BinanceCallEvidence = {
  at: number;
  method: string;
  path: string;
  status: number | null;
  /** Response body with the key and signature removed; request params kept. */
  body: string | null;
  error: string | null;
};

/** HMAC-SHA256 of the exact query string, hex encoded (Binance SIGNED). */
export function binanceSignature(query: string, secret: string) {
  return createHmac("sha256", secret).update(query).digest("hex");
}

export class BinanceApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** True when the request may have reached the exchange (timeouts, resets). */
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
  }
}

const redact = (text: string, secrets: string[]) =>
  secrets.reduce(
    (value, secret) => (secret ? value.split(secret).join("***") : value),
    text,
  );

export class BinanceSimClient {
  private offset: number | null = null;
  constructor(
    private readonly credential: BinanceSimCredential,
    private readonly retain: (entry: BinanceCallEvidence) => void,
    private readonly options: OutboundOptions & { now?: () => number } = {},
  ) {}
  private get host() {
    return binanceSimNetworks[this.credential.network];
  }
  private now() {
    return (this.options.now ?? Date.now)();
  }

  private async call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | undefined>,
    signed: boolean,
  ): Promise<unknown> {
    const query = new URLSearchParams(
      Object.entries(params).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    if (signed) {
      query.set("timestamp", String(this.now() + (await this.clockOffset())));
      query.set("recvWindow", "5000");
      query.set(
        "signature",
        binanceSignature(query.toString(), this.credential.apiSecret),
      );
    }
    const secrets = [
      this.credential.apiKey,
      this.credential.apiSecret,
      query.get("signature") ?? "",
    ];
    const entry: BinanceCallEvidence = {
      at: this.now(),
      method,
      path,
      status: null,
      body: null,
      error: null,
    };
    try {
      const { response } = await outboundFetch(
        `${this.host}${path}?${query.toString()}`,
        {
          method,
          headers: signed ? { "X-MBX-APIKEY": this.credential.apiKey } : {},
        },
        // Orders and cancels are never re-sent over another route.
        method === "GET" ? this.options : { ...this.options, singleAttempt: true },
      );
      const text = await response.text();
      entry.status = response.status;
      entry.body = redact(text.slice(0, 4000), secrets);
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        if (response.ok) throw new BinanceApiError("币安返回了非 JSON 内容", response.status, true);
      }
      if (!response.ok) {
        const detail = z
          .object({ code: z.number(), msg: z.string() })
          .safeParse(body);
        throw new BinanceApiError(
          detail.success
            ? `币安 ${detail.data.code}：${detail.data.msg}`
            : `币安 HTTP ${response.status}`,
          response.status,
          // 5xx and 503 "unknown" responses may still have executed.
          response.status >= 500,
        );
      }
      return body;
    } catch (error) {
      entry.error = redact(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      if (error instanceof BinanceApiError) throw error;
      throw new BinanceApiError(entry.error, null, true);
    } finally {
      this.retain(entry);
    }
  }

  /** Server clock offset, measured once per client; signed calls use it. */
  private async clockOffset() {
    if (this.offset !== null) return this.offset;
    const started = this.now();
    const body = z
      .object({ serverTime: z.number() })
      .parse(await this.call("GET", "/api/v3/time", {}, false));
    this.offset = body.serverTime - Math.round((started + this.now()) / 2);
    return this.offset;
  }

  account() {
    return this.call("GET", "/api/v3/account", { omitZeroBalances: "true" }, true);
  }
  openOrders(symbol?: string) {
    return this.call("GET", "/api/v3/openOrders", { symbol }, true);
  }
  myTrades(symbol: string) {
    return this.call("GET", "/api/v3/myTrades", { symbol, limit: "50" }, true);
  }
  exchangeInfo(symbol: string) {
    return this.call("GET", "/api/v3/exchangeInfo", { symbol }, false);
  }
  price(symbol: string) {
    return this.call("GET", "/api/v3/ticker/price", { symbol }, false);
  }
  newOrder(order: {
    symbol: string;
    side: "BUY" | "SELL";
    type: "LIMIT" | "MARKET";
    quantity: string;
    price?: string;
    clientOrderId: string;
  }) {
    return this.call(
      "POST",
      "/api/v3/order",
      {
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        ...(order.type === "LIMIT"
          ? { price: order.price, timeInForce: "GTC" }
          : {}),
        newClientOrderId: order.clientOrderId,
        newOrderRespType: "RESULT",
      },
      true,
    );
  }
  cancelOrder(symbol: string, orderId: string) {
    return this.call("DELETE", "/api/v3/order", { symbol, orderId }, true);
  }
}
