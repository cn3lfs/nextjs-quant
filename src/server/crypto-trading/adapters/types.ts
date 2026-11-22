import { createHmac } from "node:crypto";
import Big from "big.js";
import { z } from "zod";
import type { PlatformTrade } from "../account-model";
import { outboundFetch, type OutboundOptions } from "../../infra/outbound";
import {
  configSchema,
  type SpotAdapter,
  type Config,
  type Credential,
  type Order,
  type Symbol,
} from "../model";

export const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const positive = decimal.refine((value) => new Big(value).gt(0));
export const nonnegative = decimal.refine((value) => new Big(value).gte(0));
export const identifier = z
  .union([z.string().min(1), z.number().int().nonnegative().safe()])
  .transform(String);
const row = z.record(z.string(), z.unknown());
export const rows = z.array(row);
const hmac = (
  text: string,
  secret: string,
  encoding: "hex" | "base64" = "hex",
) => createHmac("sha256", secret).update(text).digest(encoding);
export class ExchangeError extends Error {
  constructor(
    message: string,
    readonly outcomeUnknown: boolean,
    readonly retryAfterMs = 0,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Fixed simulated private destinations. Public Bybit Demo market data is mainnet by contract. */

export class SimulatedSpotTransport {
  private offset = 0;
  private historyReadQueue: Promise<void> = Promise.resolve();
  private lastHistoryStartedAt: number | null = null;
  private syncedAt: number | null = null;
  private cooldownUntil = 0;
  private readonly config: Config;
  private readonly signatures = new Set<string>();
  constructor(
    config: Config,
    private readonly credential: Credential,
    private readonly options: OutboundOptions = {},
  ) {
    this.config = configSchema.parse(config);
    if (
      !credential.apiKey ||
      !credential.apiSecret ||
      (config.venue === "okx" && !credential.passphrase)
    )
      throw new Error("模拟账户凭证不完整");
  }
  now() {
    return (this.options.now ?? Date.now)();
  }

  get venue() {
    return this.config.venue;
  }

  serverNow() {
    return this.now() + this.offset;
  }
  private host(privateCall: boolean) {
    if (this.config.venue === "binance")
      return this.config.network === "demo"
        ? "https://demo-api.binance.com"
        : "https://testnet.binance.vision";
    if (this.config.venue === "okx") return "https://openapi.okx.com";
    return privateCall ? "https://api-demo.bybit.com" : "https://api.bybit.com";
  }
  private sanitize(value: unknown): unknown {
    let text = JSON.stringify(value);
    for (const secret of [
      this.credential.apiKey,
      this.credential.apiSecret,
      this.credential.passphrase,
      ...this.signatures,
    ])
      if (secret) text = text.split(secret).join("***");
    return JSON.parse(text) as unknown;
  }
  async clock() {
    if (this.syncedAt !== null && this.now() - this.syncedAt < 60_000) return;
    const started = this.now();
    let server: number;
    if (this.config.venue === "binance")
      server = z
        .object({ serverTime: z.number() })
        .parse(await this.request("GET", "/api/v3/time", {}, false)).serverTime;
    else if (this.config.venue === "okx")
      server = Number(
        z
          .array(z.object({ ts: decimal }))
          .min(1)
          .parse(
            await this.request("GET", "/api/v5/public/time", {}, false),
          )[0]!.ts,
      );
    else
      server =
        Number(
          z
            .object({ timeSecond: decimal })
            .parse(await this.request("GET", "/v5/market/time", {}, false))
            .timeSecond,
        ) * 1000;
    if (!Number.isSafeInteger(server)) throw new Error("无效平台时间");
    this.offset = server - (started + this.now()) / 2;
    this.syncedAt = this.now();
  }
  async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean>,
    signed = true,
  ): Promise<unknown> {
    if (this.now() < this.cooldownUntil)
      throw new ExchangeError(
        "平台限流冷却中",
        method !== "GET",
        this.cooldownUntil - this.now(),
      );
    if (signed) await this.clock();
    const venue = this.config.venue;
    const query = new URLSearchParams(
      Object.entries(params).map(([key, value]) => [key, String(value)]),
    );
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    let body: string | undefined;
    if (venue === "binance") {
      if (signed) {
        query.set("timestamp", String(Math.round(this.now() + this.offset)));
        query.set("recvWindow", "5000");
        const signature = hmac(query.toString(), this.credential.apiSecret);
        this.signatures.add(signature);
        query.set("signature", signature);
        headers["X-MBX-APIKEY"] = this.credential.apiKey;
      }
    } else {
      if (method !== "GET") body = JSON.stringify(params);
      if (venue === "okx") {
        headers["x-simulated-trading"] = "1";
        if (signed) {
          const timestamp = new Date(this.now() + this.offset).toISOString();
          const requestPath =
            path + (method === "GET" && query.size ? `?${query}` : "");
          headers["OK-ACCESS-KEY"] = this.credential.apiKey;
          headers["OK-ACCESS-PASSPHRASE"] = this.credential.passphrase!;
          headers["OK-ACCESS-TIMESTAMP"] = timestamp;
          headers["OK-ACCESS-SIGN"] = hmac(
            timestamp + method + requestPath + (body ?? ""),
            this.credential.apiSecret,
            "base64",
          );
        }
      } else if (signed) {
        const timestamp = String(Math.round(this.now() + this.offset));
        headers["X-BAPI-API-KEY"] = this.credential.apiKey;
        headers["X-BAPI-TIMESTAMP"] = timestamp;
        headers["X-BAPI-RECV-WINDOW"] = "5000";
        headers["X-BAPI-SIGN"] = hmac(
          timestamp +
            this.credential.apiKey +
            "5000" +
            (method === "GET" ? query.toString() : (body ?? "")),
          this.credential.apiSecret,
        );
      }
    }
    for (const name of ["OK-ACCESS-SIGN", "X-BAPI-SIGN"])
      if (headers[name]) this.signatures.add(headers[name]);
    const url =
      this.host(signed) +
      path +
      ((venue === "binance" || method === "GET") && query.size
        ? `?${query}`
        : "");
    try {
      const { response } = await outboundFetch(
        url,
        { method, headers, body },
        { ...this.options, singleAttempt: method !== "GET" },
      );
      if (!response.ok) {
        let code: string | undefined;
        let definiteRejection = false;
        try {
          const detail = row.parse(await response.json());
          code = String(
            (venue === "bybit" ? detail.retCode : detail.code) ?? "",
          );
          definiteRejection =
            (venue === "okx" && code === "51008") ||
            (venue === "binance" &&
              code === "-2010" &&
              detail.msg ===
                "Account has insufficient balance for requested action.");
        } catch {
          /* No untrusted response text in credential-bearing errors. */
        }
        if (response.status === 429 || response.status === 418) {
          const retry =
            Number(response.headers.get("retry-after") ?? "5") * 1000;
          this.cooldownUntil =
            this.now() + Math.max(1000, Number.isFinite(retry) ? retry : 5000);
        }
        throw new ExchangeError(
          `平台 HTTP ${response.status}${code ? ` (${code})` : ""}`,
          method !== "GET" &&
            (response.status >= 500 ||
              response.status === 429 ||
              response.status === 418 ||
              !definiteRejection),
          this.cooldownUntil - this.now(),
          code,
        );
      }
      const raw: unknown = await response.json();
      if (venue === "binance") return this.sanitize(raw);
      if (venue === "okx") {
        const envelope = z
          .object({ code: z.string(), data: z.unknown() })
          .parse(raw);
        if (
          method === "POST" &&
          path === "/api/v5/trade/order" &&
          (envelope.code === "0" || envelope.code === "1")
        ) {
          const [result] = rows.length(1).parse(envelope.data);
          const code = result!.sCode;
          if (typeof code === "string" && code !== "0")
            throw new ExchangeError(
              `OKX下单 ${code}`,
              // A rejection code alongside an assigned order id is contradictory;
              // never turn that into a definite rejection that permits a resend.
              code !== "51008" || !!result!.ordId,
              0,
              code,
            );
        }
        if (envelope.code !== "0") {
          if (envelope.code === "50011") this.cooldownUntil = this.now() + 5000;
          throw new ExchangeError(
            `OKX ${envelope.code}`,
            method !== "GET" && envelope.code !== "51008",
            this.cooldownUntil - this.now(),
            envelope.code,
          );
        }
        return this.sanitize(envelope.data);
      }
      const envelope = z
        .object({ retCode: z.number(), result: z.unknown() })
        .parse(raw);
      if (envelope.retCode !== 0) {
        if (envelope.retCode === 10006) this.cooldownUntil = this.now() + 5000;
        throw new ExchangeError(
          `Bybit ${envelope.retCode}`,
          method !== "GET",
          this.cooldownUntil - this.now(),
          String(envelope.retCode),
        );
      }
      return this.sanitize(envelope.result);
    } catch (error) {
      if (error instanceof ExchangeError) throw error;
      // Never include request URLs, signatures, proxy credentials or raw exception messages.
      throw new ExchangeError("平台请求失败或返回格式无效", method !== "GET");
    }
  }
  /** Pace history pages across symbols/calls without delaying execution requests. */
  historyPage(path: string, params: Record<string, string>): Promise<unknown> {
    const pending = this.historyReadQueue.then(async () => {
      // Clock lookup is outside the spacing measurement: only actual history
      // requests count. Signing fixtures may freeze options.now, so use the wall clock.
      await this.clock();
      if (this.lastHistoryStartedAt !== null) {
        const delay = 250 - (Date.now() - this.lastHistoryStartedAt);
        if (delay > 0)
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      this.lastHistoryStartedAt = Date.now();
      return this.request("GET", path, params);
    });
    this.historyReadQueue = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
}
export const tradeTime = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
]);
export const numericId = identifier.refine((value) => /^\d+$/.test(value));

type FetchHistoryPage = (
  path: string,
  params: Record<string, string>,
) => Promise<unknown>;

export type VenueOperations = Pick<
  SpotAdapter,
  "snapshot" | "rules" | "candles" | "price" | "cancel"
> & {
  place(
    order: Order,
    quoteBudget: string | undefined,
  ): ReturnType<SpotAdapter["place"]>;
  readOrder(
    order: Order,
  ): Promise<
    | (Required<
        Pick<Order, "exchangeId" | "state" | "executedQuantity" | "fills">
      > & { raw: unknown })
    | null
  >;
  readTrades(
    symbol: Symbol,
    from: number,
    to: number,
    fetchPage: FetchHistoryPage,
  ): Promise<PlatformTrade[]>;
};
