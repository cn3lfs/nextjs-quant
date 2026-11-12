import { createHmac } from "node:crypto";
import Big from "big.js";
import { z } from "zod";
import type { AccountHistoryAdapter, PlatformTrade } from "./account-model";
import { outboundFetch, type OutboundOptions } from "../infra/outbound";
import {
  configSchema,
  terminal,
  type Candle,
  type Config,
  type Credential,
  type Fill,
  type Order,
  type Rules,
  type Snapshot,
  type Symbol,
} from "./model";

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const positive = decimal.refine((value) => new Big(value).gt(0));
const nonnegative = decimal.refine((value) => new Big(value).gte(0));
const identifier = z
  .union([z.string().min(1), z.number().int().nonnegative().safe()])
  .transform(String);
const row = z.record(z.string(), z.unknown());
const rows = z.array(row);
const minimum = (a: string, b: string) => (new Big(a).lt(b) ? a : b);
const maximum = (a: string, b: string) => (new Big(a).gt(b) ? a : b);
function commonStep(a: string, b: string) {
  const scale = Math.max(
    a.split(".")[1]?.length ?? 0,
    b.split(".")[1]?.length ?? 0,
  );
  const factor = new Big(10).pow(scale);
  const first = BigInt(new Big(a).times(factor).toFixed(0));
  const second = BigInt(new Big(b).times(factor).toFixed(0));
  let x = first,
    y = second;
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return new Big(((first / x) * second).toString()).div(factor).toFixed();
}
const hmac = (
  text: string,
  secret: string,
  encoding: "hex" | "base64" = "hex",
) => createHmac("sha256", secret).update(text).digest(encoding);
const pair = (symbol: Symbol) => symbol.replace("USDT", "-USDT");
const checkedSymbol = (symbol: Symbol) =>
  z.enum(["BTCUSDT", "ETHUSDT"]).parse(symbol);

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
export class SimulatedSpotAdapter implements AccountHistoryAdapter {
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
  private now() {
    return (this.options.now ?? Date.now)();
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
  private async clock() {
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
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean>,
    signed = true,
  ): Promise<unknown> {
    if (this.now() < this.cooldownUntil)
      throw new ExchangeError(
        "平台限流冷却中",
        false,
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
        let duplicateClientId = false;
        try {
          const detail = row.parse(await response.json());
          code = String(detail.code ?? detail.retCode ?? "");
          const sanitized = row.parse(this.sanitize(detail));
          duplicateClientId =
            code === "-2010" &&
            typeof sanitized.msg === "string" &&
            /duplicate/i.test(sanitized.msg);
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
              ["-1006", "-1007"].includes(code ?? "") ||
              duplicateClientId),
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
        if (envelope.code !== "0") {
          if (envelope.code === "50011") this.cooldownUntil = this.now() + 5000;
          throw new ExchangeError(
            `OKX ${envelope.code}`,
            method !== "GET" && ["50004", "50001"].includes(envelope.code),
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
          method !== "GET" && [10000, 10016].includes(envelope.retCode),
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
  async snapshot(): Promise<Snapshot> {
    if (this.config.venue === "binance") {
      const account = z
        .object({
          canTrade: z.boolean(),
          balances: z.array(
            z.object({
              asset: z.string(),
              free: nonnegative,
              locked: nonnegative,
            }),
          ),
        })
        .parse(await this.request("GET", "/api/v3/account", {}));
      if (!account.canTrade) throw new Error("模拟账户不可交易");
      return {
        balances: account.balances.map((x) => ({
          asset: x.asset,
          free: x.free,
          total: new Big(x.free).plus(x.locked).toFixed(),
        })),
        openOrders: rows.parse(
          await this.request("GET", "/api/v3/openOrders", {}),
        ),
      };
    }
    if (this.config.venue === "okx") {
      const account = z
        .array(
          z.object({
            details: z.array(
              z.object({
                ccy: z.string(),
                cashBal: decimal,
                availBal: decimal,
              }),
            ),
          }),
        )
        .min(1)
        .parse(await this.request("GET", "/api/v5/account/balance", {}));
      const pending = await this.collectOkx(
        "/api/v5/trade/orders-pending",
        { instType: "SPOT" },
        "ordId",
      );
      return {
        balances: account[0]!.details.map((x) => ({
          asset: x.ccy,
          free: nonnegative.parse(x.availBal),
          total: nonnegative.parse(x.cashBal),
        })),
        openOrders: pending,
      };
    }
    const account = z
      .object({
        list: z
          .array(
            z.object({
              totalPositionIM: nonnegative,
              totalOrderIM: nonnegative,
              coin: z.array(
                z.object({
                  coin: z.string(),
                  walletBalance: nonnegative,
                  locked: nonnegative,
                  borrowAmount: decimal.optional(),
                  spotBorrow: decimal.optional(),
                }),
              ),
            }),
          )
          .min(1),
      })
      .parse(
        await this.request("GET", "/v5/account/wallet-balance", {
          accountType: "UNIFIED",
        }),
      );
    if (
      new Big(account.list[0]!.totalPositionIM).gt(0) ||
      new Big(account.list[0]!.totalOrderIM).gt(0)
    )
      throw new Error("模拟账户有保证金占用，请使用独立现货账户");
    const balances = account.list[0]!.coin.map((x) => {
      if (
        new Big(x.borrowAmount ?? "0").gt(0) ||
        new Big(x.spotBorrow ?? "0").gt(0)
      )
        throw new Error("模拟账户存在借贷，请使用无借贷现货账户");
      const free = new Big(x.walletBalance).minus(x.locked);
      return {
        asset: x.coin,
        free: nonnegative.parse(free.toFixed()),
        total: x.walletBalance,
      };
    });
    return {
      balances,
      openOrders: await this.collectBybit("/v5/order/realtime", {
        category: "spot",
        openOnly: "0",
      }),
    };
  }
  async rules(symbol: Symbol): Promise<Rules> {
    checkedSymbol(symbol);
    if (this.config.venue === "binance") {
      const info = z
        .object({
          symbols: z
            .array(
              z.object({
                symbol: z.string(),
                status: z.string(),
                filters: rows,
              }),
            )
            .min(1),
        })
        .parse(
          await this.request("GET", "/api/v3/exchangeInfo", { symbol }, false),
        )
        .symbols.find((x) => x.symbol === symbol);
      if (!info || info.status !== "TRADING") throw new Error("交易对不可交易");
      const filter = (type: string) =>
        info.filters.find((x) => x.filterType === type);
      const regular = filter("LOT_SIZE"),
        market = filter("MARKET_LOT_SIZE");
      const lot = z
        .object({
          minQty: nonnegative,
          maxQty: positive,
          stepSize: nonnegative,
        })
        .parse(regular);
      const marketLot = market
        ? z
            .object({
              minQty: nonnegative,
              maxQty: nonnegative,
              stepSize: nonnegative,
            })
            .parse(market)
        : null;
      const step =
        marketLot && new Big(marketLot.stepSize).gt(0)
          ? commonStep(positive.parse(lot.stepSize), marketLot.stepSize)
          : positive.parse(lot.stepSize);
      const max =
        marketLot && new Big(marketLot.maxQty).gt(0)
          ? minimum(lot.maxQty, marketLot.maxQty)
          : lot.maxQty;
      const notional = filter("NOTIONAL") ?? filter("MIN_NOTIONAL");
      const applyMin =
        notional?.filterType === "NOTIONAL"
          ? notional.applyMinToMarket
          : notional?.applyToMarket;
      const minValue =
        notional && applyMin !== false
          ? nonnegative.parse(notional.minNotional)
          : "0";
      const maxValue =
        notional?.filterType === "NOTIONAL" &&
        notional.applyMaxToMarket === true
          ? positive.parse(notional.maxNotional)
          : undefined;
      return {
        step,
        min: marketLot ? maximum(lot.minQty, marketLot.minQty) : lot.minQty,
        max,
        minValue,
        ...(maxValue ? { maxValue } : {}),
      };
    }
    if (this.config.venue === "okx") {
      const info = z
        .array(
          z.object({
            instId: z.string(),
            state: z.string(),
            lotSz: positive,
            minSz: positive,
            maxMktSz: positive,
          }),
        )
        .min(1)
        .parse(
          await this.request(
            "GET",
            "/api/v5/public/instruments",
            { instType: "SPOT", instId: pair(symbol) },
            false,
          ),
        )
        .find((x) => x.instId === pair(symbol));
      if (!info || info.state !== "live") throw new Error("交易对不可交易");
      return {
        step: info.lotSz,
        min: info.minSz,
        max: info.maxMktSz,
        minValue: "0",
      };
    }
    const info = z
      .object({
        list: z
          .array(
            z.object({
              symbol: z.string(),
              status: z.string(),
              lotSizeFilter: z.object({
                basePrecision: positive,
                maxMarketOrderQty: positive,
                minOrderAmt: positive,
              }),
            }),
          )
          .min(1),
      })
      .parse(
        await this.request(
          "GET",
          "/v5/market/instruments-info",
          { category: "spot", symbol },
          false,
        ),
      )
      .list.find((x) => x.symbol === symbol);
    if (!info || info.status !== "Trading") throw new Error("交易对不可交易");
    return {
      step: info.lotSizeFilter.basePrecision,
      min: "0",
      max: info.lotSizeFilter.maxMarketOrderQty,
      minValue: info.lotSizeFilter.minOrderAmt,
    };
  }
  async candles(
    symbol: Symbol,
    minutes: 15 | 60,
    limit: number,
  ): Promise<Candle[]> {
    checkedSymbol(symbol);
    if (
      ![15, 60].includes(minutes) ||
      !Number.isInteger(limit) ||
      limit < 2 ||
      limit > 250
    )
      throw new Error("K线请求参数无效");
    await this.clock();
    let candles: Candle[];
    if (this.config.venue === "binance") {
      const result = z
        .array(z.array(z.union([z.string(), z.number()])).min(7))
        .parse(
          await this.request(
            "GET",
            "/api/v3/klines",
            {
              symbol,
              interval: minutes === 60 ? "1h" : "15m",
              limit: String(limit + 1),
            },
            false,
          ),
        );
      candles = result
        .filter((x) => Number(x[6]) < this.now() + this.offset)
        .map((x) => ({ time: Number(x[0]), close: Number(x[4]) }));
    } else if (this.config.venue === "okx") {
      const result = z.array(z.array(z.string()).min(9)).parse(
        await this.request(
          "GET",
          "/api/v5/market/candles",
          {
            instId: pair(symbol),
            bar: minutes === 60 ? "1H" : "15m",
            limit: String(limit + 1),
          },
          false,
        ),
      );
      candles = result
        .filter((x) => x[8] === "1")
        .map((x) => ({ time: Number(x[0]), close: Number(x[4]) }));
    } else {
      const result = z
        .object({ list: z.array(z.array(z.string()).min(7)) })
        .parse(
          await this.request(
            "GET",
            "/v5/market/kline",
            {
              category: "spot",
              symbol,
              interval: String(minutes),
              limit: String(limit + 1),
            },
            false,
          ),
        );
      candles = result.list
        .filter(
          (x) => Number(x[0]) + minutes * 60_000 <= this.now() + this.offset,
        )
        .map((x) => ({ time: Number(x[0]), close: Number(x[4]) }));
    }
    candles.sort((a, b) => a.time - b.time);
    for (let i = 0; i < candles.length; i++) {
      const item = candles[i]!;
      if (
        !Number.isSafeInteger(item.time) ||
        !Number.isFinite(item.close) ||
        item.close <= 0 ||
        item.time + minutes * 60_000 > this.now() + this.offset
      )
        throw new Error("无效或未完成K线");
      if (i > 0 && item.time - candles[i - 1]!.time !== minutes * 60_000)
        throw new Error("K线存在重复或缺口");
    }
    return candles.slice(-limit);
  }
  async price(symbol: Symbol): Promise<string> {
    checkedSymbol(symbol);
    if (this.config.venue === "binance")
      return z
        .object({ price: positive })
        .parse(
          await this.request("GET", "/api/v3/ticker/price", { symbol }, false),
        ).price;
    if (this.config.venue === "okx")
      return z
        .array(z.object({ last: positive }))
        .min(1)
        .parse(
          await this.request(
            "GET",
            "/api/v5/market/ticker",
            { instId: pair(symbol) },
            false,
          ),
        )[0]!.last;
    return z
      .object({ list: z.array(z.object({ lastPrice: positive })).min(1) })
      .parse(
        await this.request(
          "GET",
          "/v5/market/tickers",
          { category: "spot", symbol },
          false,
        ),
      ).list[0]!.lastPrice;
  }
  async place(order: Order) {
    checkedSymbol(order.symbol);
    positive.parse(order.quantity);
    const quoteBudget =
      order.quoteBudget === undefined
        ? undefined
        : positive.parse(order.quoteBudget);
    if (quoteBudget !== undefined && order.side !== "BUY")
      throw new ExchangeError("报价预算只允许用于买入", false);
    z.string()
      .regex(/^[a-zA-Z0-9]{1,32}$/)
      .parse(order.clientId);
    if (this.config.venue === "binance") {
      const raw = await this.request("POST", "/api/v3/order", {
        symbol: order.symbol,
        side: order.side,
        type: "MARKET",
        ...(quoteBudget === undefined
          ? { quantity: order.quantity }
          : { quoteOrderQty: quoteBudget }),
        newClientOrderId: order.clientId,
        newOrderRespType: "RESULT",
      });
      return {
        exchangeId: z.object({ orderId: identifier }).parse(raw).orderId,
        raw,
      };
    }
    if (this.config.venue === "okx") {
      const raw = await this.request("POST", "/api/v5/trade/order", {
        instId: pair(order.symbol),
        tdMode: "cash",
        side: order.side.toLowerCase(),
        ordType: "market",
        sz: quoteBudget ?? order.quantity,
        tgtCcy: quoteBudget === undefined ? "base_ccy" : "quote_ccy",
        clOrdId: order.clientId,
        banAmend: true,
      });
      const result = z
        .array(z.object({ sCode: z.string(), ordId: z.string() }))
        .min(1)
        .parse(raw)[0]!;
      if (result.sCode !== "0")
        throw new ExchangeError(
          `OKX下单 ${result.sCode}`,
          ["50004", "51011"].includes(result.sCode),
          0,
          result.sCode,
        );
      return { exchangeId: identifier.parse(result.ordId), raw };
    }
    const raw = await this.request("POST", "/v5/order/create", {
      category: "spot",
      symbol: order.symbol,
      side: order.side === "BUY" ? "Buy" : "Sell",
      orderType: "Market",
      qty: quoteBudget ?? order.quantity,
      marketUnit: quoteBudget === undefined ? "baseCoin" : "quoteCoin",
      isLeverage: 0,
      orderLinkId: order.clientId,
    });
    return {
      exchangeId: z.object({ orderId: identifier }).parse(raw).orderId,
      raw,
    };
  }
  private async collectOkx(
    path: string,
    params: Record<string, string>,
    cursorField: string,
  ) {
    const result: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const batch = rows.parse(
        await this.request("GET", path, {
          ...params,
          limit: "100",
          ...(after ? { after } : {}),
        }),
      );
      result.push(...batch);
      if (batch.length < 100) return result;
      const next = identifier.parse(batch.at(-1)?.[cursorField]);
      if (next === after) throw new Error("OKX分页游标未推进");
      after = next;
    }
    throw new Error("OKX分页超出安全上限，结果不完整");
  }
  private async collectBybit(path: string, params: Record<string, string>) {
    const result: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const batch = z
        .object({ list: rows, nextPageCursor: z.string().optional() })
        .parse(
          await this.request("GET", path, {
            ...params,
            limit: path.startsWith("/v5/order/") ? "50" : "100",
            ...(cursor ? { cursor } : {}),
          }),
        );
      result.push(...batch.list);
      if (!batch.nextPageCursor) return result;
      if (batch.nextPageCursor === cursor)
        throw new Error("Bybit分页游标未推进");
      cursor = batch.nextPageCursor;
    }
    throw new Error("Bybit分页超出安全上限，结果不完整");
  }
  /** Pace history pages across symbols/calls without delaying execution requests. */
  private historyPage(
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
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
  /** Read every account fill in an execution-time UTC half-open interval, including orders created elsewhere. */
  async tradeHistory(
    symbol: Symbol,
    from: number,
    to: number,
  ): Promise<PlatformTrade[]> {
    checkedSymbol(symbol);
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to <= from ||
      to - from > 90 * 86400000
    )
      throw new Error("成交历史时间范围无效（最多90天）");
    const time = z.union([
      z.number().int().nonnegative().safe(),
      z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger),
    ]);
    const numericId = identifier.refine((value) => /^\d+$/.test(value));
    const binanceSchema = z
      .object({
        id: numericId,
        orderId: numericId,
        symbol: z.literal(symbol),
        isBuyer: z.boolean(),
        time,
        qty: positive,
        price: positive,
        quoteQty: positive,
        commission: decimal,
        commissionAsset: z.string().min(1),
      })
      .passthrough();
    const okxSchema = z
      .object({
        tradeId: identifier,
        billId: numericId,
        ordId: identifier,
        instId: z.literal(pair(symbol)),
        instType: z.literal("SPOT").optional(),
        clOrdId: z.string().optional(),
        side: z.enum(["buy", "sell"]),
        fillTime: time,
        ts: time,
        fillSz: positive,
        fillPx: positive,
        fee: decimal,
        feeCcy: z.string().min(1),
      })
      .passthrough();
    const bybitSchema = z
      .object({
        execId: identifier,
        orderId: identifier,
        orderLinkId: z.string().optional(),
        symbol: z.literal(symbol),
        side: z.enum(["Buy", "Sell"]),
        execTime: time,
        execQty: positive,
        execPrice: positive,
        execValue: positive,
        execFee: decimal,
        feeCurrency: z.string().min(1),
        extraFees: z.literal("").optional(),
      })
      .passthrough();
    const collected: PlatformTrade[] = [];
    let requests = 0;
    const fetchPage = async (path: string, params: Record<string, string>) => {
      if (++requests > 1000)
        throw new Error("成交历史分页超出安全上限，范围不完整");
      return this.historyPage(path, params);
    };
    const mapBinance = (
      trade: z.infer<typeof binanceSchema>,
    ): PlatformTrade => ({
      id: trade.id,
      orderId: trade.orderId,
      symbol,
      side: trade.isBuyer ? "BUY" : "SELL",
      time: trade.time,
      quantity: trade.qty,
      price: trade.price,
      quoteQuantity: trade.quoteQty,
      fee: trade.commission,
      feeAsset: trade.commissionAsset,
      raw: trade,
    });
    if (this.config.venue === "binance") {
      // Time-limited queries return the most recent subset when saturated. Splitting
      // avoids assuming the first page starts at the oldest trade in the interval.
      const readWindow = async (start: number, end: number): Promise<void> => {
        const page = z
          .array(binanceSchema)
          .max(1000)
          .parse(
            await fetchPage("/api/v3/myTrades", {
              symbol,
              startTime: String(start),
              endTime: String(end - 1),
              limit: "1000",
            }),
          );
        if (page.some((trade) => trade.time < start || trade.time >= end))
          throw new Error("币安返回超出请求时间窗的成交");
        if (page.length < 1000) {
          collected.push(...page.map(mapBinance));
          return;
        }
        if (end - start > 1) {
          const middle = start + Math.floor((end - start) / 2);
          await readWindow(start, middle);
          await readWindow(middle, end);
          return;
        }
        // More than 1000 trades at the same millisecond cannot be paged by time.
        // fromId cannot coexist with time filters: walk ascending IDs and verify
        // their time order, preserving same-timestamp fills instead of skipping ms.
        let fromId = "0",
          previousId = -1n,
          previousTime = -1;
        for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
          const batch = z
            .array(binanceSchema)
            .max(1000)
            .parse(
              await fetchPage("/api/v3/myTrades", {
                symbol,
                fromId,
                limit: "1000",
              }),
            );
          for (const trade of batch) {
            const id = BigInt(trade.id);
            if (
              id < BigInt(fromId) ||
              id <= previousId ||
              trade.time < previousTime
            )
              throw new Error("币安成交ID分页顺序异常");
            previousId = id;
            previousTime = trade.time;
            if (trade.time >= start && trade.time < end)
              collected.push(mapBinance(trade));
          }
          if (batch.length < 1000 || (batch.at(-1)?.time ?? -1) >= end) return;
          fromId = (previousId + 1n).toString();
        }
        throw new Error("币安同毫秒成交分页超出安全上限，范围不完整");
      };
      for (let start = from; start < to; start += 86400000)
        await readWindow(start, Math.min(to, start + 86400000));
    } else if (this.config.venue === "okx") {
      let after: string | undefined;
      // OKX filters record creation ts, not fillTime. Read through the current
      // observation time so a fill recorded after the requested end isn't lost.
      const recordEnd = Math.max(to, this.now());
      for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
        const page = z
          .array(okxSchema)
          .max(100)
          .parse(
            await fetchPage("/api/v5/trade/fills-history", {
              instType: "SPOT",
              instId: pair(symbol),
              begin: String(from),
              end: String(recordEnd),
              limit: "100",
              ...(after ? { after } : {}),
            }),
          );
        for (const trade of page) {
          if (after !== undefined && BigInt(trade.billId) >= BigInt(after))
            throw new Error("OKX成交分页游标未推进");
          collected.push({
            id: trade.tradeId,
            orderId: trade.ordId,
            ...(trade.clOrdId ? { clientOrderId: trade.clOrdId } : {}),
            symbol,
            side: trade.side === "buy" ? "BUY" : "SELL",
            time: trade.fillTime,
            quantity: trade.fillSz,
            price: trade.fillPx,
            quoteQuantity: new Big(trade.fillSz).times(trade.fillPx).toFixed(),
            fee: new Big(trade.fee).neg().toFixed(),
            feeAsset: trade.feeCcy,
            raw: trade,
          });
        }
        if (page.length < 100) break;
        const next = page.reduce(
          (min, trade) =>
            BigInt(trade.billId) < BigInt(min) ? trade.billId : min,
          page[0]!.billId,
        );
        if (next === after || pageIndex === 99)
          throw new Error("OKX成交分页不完整");
        after = next;
      }
    } else {
      for (let start = from; start < to; start += 7 * 86400000) {
        const end = Math.min(to, start + 7 * 86400000);
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
          const envelope = z
            .object({
              list: z.array(bybitSchema).max(100),
              nextPageCursor: z.string().optional(),
            })
            .parse(
              await fetchPage("/v5/execution/list", {
                category: "spot",
                symbol,
                startTime: String(start),
                endTime: String(end - 1),
                limit: "100",
                ...(cursor ? { cursor } : {}),
              }),
            );
          for (const trade of envelope.list)
            collected.push({
              id: trade.execId,
              orderId: trade.orderId,
              ...(trade.orderLinkId
                ? { clientOrderId: trade.orderLinkId }
                : {}),
              symbol,
              side: trade.side === "Buy" ? "BUY" : "SELL",
              time: trade.execTime,
              quantity: trade.execQty,
              price: trade.execPrice,
              quoteQuantity: trade.execValue,
              fee: trade.execFee,
              feeAsset: trade.feeCurrency,
              raw: trade,
            });
          if (!envelope.nextPageCursor) break;
          if (seenCursors.has(envelope.nextPageCursor) || pageIndex === 99)
            throw new Error("Bybit成交分页游标重复或超出安全上限");
          cursor = envelope.nextPageCursor;
          seenCursors.add(cursor);
        }
      }
    }
    const unique = new Map<string, PlatformTrade>();
    for (const trade of collected) {
      // All rows are validated above, including records outside the final range.
      if (trade.time < from || trade.time >= to) continue;
      const identity = JSON.stringify([trade.symbol, trade.orderId, trade.id]);
      const previous = unique.get(identity);
      if (previous) {
        const previousFields = { ...previous },
          nextFields = { ...trade };
        delete previousFields.raw;
        delete nextFields.raw;
        if (JSON.stringify(previousFields) !== JSON.stringify(nextFields))
          throw new Error("相同平台成交ID的业务字段冲突");
      } else unique.set(identity, trade);
    }
    return [...unique.values()].sort(
      (a, b) =>
        a.time - b.time ||
        a.orderId.localeCompare(b.orderId) ||
        a.id.localeCompare(b.id),
    );
  }
  async reconcile(order: Order): Promise<Order | null> {
    checkedSymbol(order.symbol);
    let state: string,
      executedQuantity: string,
      exchangeId: string,
      raw: unknown;
    let fills: Fill[] = [];
    if (this.config.venue === "binance") {
      try {
        raw = await this.request("GET", "/api/v3/order", {
          symbol: order.symbol,
          origClientOrderId: order.clientId,
        });
      } catch (error) {
        if (error instanceof ExchangeError && error.code === "-2013")
          return null;
        throw error;
      }
      const found = z
        .object({
          orderId: identifier,
          status: z.string(),
          executedQty: nonnegative,
          clientOrderId: z.string(),
          symbol: z.string(),
          side: z.string(),
        })
        .parse(raw);
      if (
        found.clientOrderId !== order.clientId ||
        found.symbol !== order.symbol ||
        found.side !== order.side
      )
        throw new Error("币安订单身份不一致");
      state = found.status;
      executedQuantity = found.executedQty;
      exchangeId = found.orderId;
      let fromId: string | undefined;
      for (let page = 0; page < 100; page++) {
        const batch = z
          .array(
            z.object({
              id: identifier,
              orderId: identifier,
              qty: positive,
              price: positive,
              commission: decimal,
              commissionAsset: z.string().min(1),
            }),
          )
          .parse(
            await this.request("GET", "/api/v3/myTrades", {
              symbol: order.symbol,
              orderId: exchangeId,
              limit: "1000",
              ...(fromId ? { fromId } : {}),
            }),
          );
        fills.push(
          ...batch
            .filter((x) => x.orderId === exchangeId)
            .map((x) => ({
              id: x.id,
              quantity: x.qty,
              price: x.price,
              fee: x.commission,
              feeAsset: x.commissionAsset,
            })),
        );
        if (batch.length < 1000) break;
        const next = (BigInt(batch.at(-1)!.id) + 1n).toString();
        if (next === fromId || page === 99)
          throw new Error("币安成交分页不完整");
        fromId = next;
      }
    } else if (this.config.venue === "okx") {
      try {
        raw = await this.request("GET", "/api/v5/trade/order", {
          instId: pair(order.symbol),
          clOrdId: order.clientId,
        });
      } catch (error) {
        if (error instanceof ExchangeError && error.code === "51603")
          return null;
        throw error;
      }
      const found = z
        .array(
          z.object({
            ordId: identifier,
            state: z.string(),
            accFillSz: nonnegative,
            clOrdId: z.string(),
            instId: z.string(),
            side: z.string(),
          }),
        )
        .min(1)
        .parse(raw)[0]!;
      if (
        found.clOrdId !== order.clientId ||
        found.instId !== pair(order.symbol) ||
        found.side !== order.side.toLowerCase()
      )
        throw new Error("OKX订单身份不一致");
      state = found.state;
      executedQuantity = found.accFillSz;
      exchangeId = found.ordId;
      const trades = z
        .array(
          z.object({
            tradeId: identifier,
            ordId: identifier,
            fillSz: positive,
            fillPx: positive,
            fee: decimal,
            feeCcy: z.string().min(1),
          }),
        )
        .parse(
          await this.collectOkx(
            "/api/v5/trade/fills-history",
            { instType: "SPOT", instId: pair(order.symbol), ordId: exchangeId },
            "billId",
          ),
        );
      fills = trades
        .filter((x) => x.ordId === exchangeId)
        .map((x) => ({
          id: x.tradeId,
          quantity: x.fillSz,
          price: x.fillPx,
          fee: new Big(x.fee).neg().toFixed(),
          feeAsset: x.feeCcy,
        }));
    } else {
      let foundRows = await this.collectBybit("/v5/order/realtime", {
        category: "spot",
        symbol: order.symbol,
        orderLinkId: order.clientId,
      });
      if (!foundRows.length)
        foundRows = await this.collectBybit("/v5/order/history", {
          category: "spot",
          symbol: order.symbol,
          orderLinkId: order.clientId,
        });
      if (!foundRows.length) return null;
      raw = foundRows;
      const found = z
        .object({
          orderId: identifier,
          orderStatus: z.string(),
          cumExecQty: nonnegative,
          orderLinkId: z.string(),
          symbol: z.string(),
          side: z.string(),
        })
        .parse(foundRows[0]);
      if (
        found.orderLinkId !== order.clientId ||
        found.symbol !== order.symbol ||
        found.side !== (order.side === "BUY" ? "Buy" : "Sell")
      )
        throw new Error("Bybit订单身份不一致");
      state = found.orderStatus;
      executedQuantity = found.cumExecQty;
      exchangeId = found.orderId;
      const trades = z
        .array(
          z.object({
            execId: identifier,
            orderId: identifier,
            execQty: positive,
            execPrice: positive,
            execFee: decimal,
            feeCurrency: z.string().min(1),
          }),
        )
        .parse(
          await this.collectBybit("/v5/execution/list", {
            category: "spot",
            symbol: order.symbol,
            orderId: exchangeId,
          }),
        );
      fills = trades
        .filter((x) => x.orderId === exchangeId)
        .map((x) => ({
          id: x.execId,
          quantity: x.execQty,
          price: x.execPrice,
          fee: x.execFee,
          feeAsset: x.feeCurrency,
        }));
    }
    const unique = new Map<string, Fill>();
    for (const fill of fills) {
      const previous = unique.get(fill.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(fill))
        throw new Error("同一成交编号内容不一致");
      unique.set(fill.id, fill);
    }
    fills = [...unique.values()];
    const filled = fills.reduce(
      (total, x) => total.plus(x.quantity),
      new Big(0),
    );
    if (
      filled.gt(executedQuantity) ||
      (terminal(state) && !filled.eq(executedQuantity))
    )
      throw new Error("订单累计成交与成交明细不一致，等待对账");
    return { ...order, state, exchangeId, executedQuantity, fills, raw };
  }
  async cancel(order: Order) {
    checkedSymbol(order.symbol);
    if (this.config.venue === "binance")
      await this.request("DELETE", "/api/v3/order", {
        symbol: order.symbol,
        origClientOrderId: order.clientId,
      });
    else if (this.config.venue === "okx") {
      const raw = await this.request("POST", "/api/v5/trade/cancel-order", {
        instId: pair(order.symbol),
        clOrdId: order.clientId,
      });
      const result = z
        .array(z.object({ sCode: z.string() }))
        .min(1)
        .parse(raw)[0]!;
      if (result.sCode !== "0")
        throw new ExchangeError(
          `OKX撤单 ${result.sCode}`,
          result.sCode === "50004",
          0,
          result.sCode,
        );
    } else
      await this.request("POST", "/v5/order/cancel", {
        category: "spot",
        symbol: order.symbol,
        orderLinkId: order.clientId,
      });
  }
}

export const createSpotAdapter = (
  config: Config,
  credential: Credential,
): AccountHistoryAdapter => new SimulatedSpotAdapter(config, credential);
