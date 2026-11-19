import Big from "big.js";
import { z } from "zod";
import type { PlatformTrade } from "../account-model";
import { type Fill } from "../model";

import {
  decimal,
  positive,
  nonnegative,
  identifier,
  rows,
  tradeTime,
  numericId,
  ExchangeError,
  type SimulatedSpotTransport,
  type VenueOperations,
} from "./types";

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

export function binanceOperations(
  transport: SimulatedSpotTransport,
): VenueOperations {
  return {
    async snapshot() {
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
        .parse(await transport.request("GET", "/api/v3/account", {}));
      if (!account.canTrade) throw new Error("模拟账户不可交易");
      return {
        balances: account.balances.map((x) => ({
          asset: x.asset,
          free: x.free,
          total: new Big(x.free).plus(x.locked).toFixed(),
        })),
        openOrders: rows.parse(
          await transport.request("GET", "/api/v3/openOrders", {}),
        ),
      };
    },
    async rules(symbol) {
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
          await transport.request(
            "GET",
            "/api/v3/exchangeInfo",
            { symbol },
            false,
          ),
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
    },
    async candles(symbol, minutes, limit) {
      const result = z
        .array(z.array(z.union([z.string(), z.number()])).min(7))
        .parse(
          await transport.request(
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
      return result
        .filter((x) => Number(x[6]) < transport.serverNow())
        .map((x) => ({ time: Number(x[0]), close: Number(x[4]) }));
    },
    async price(symbol) {
      return z
        .object({ price: positive })
        .parse(
          await transport.request(
            "GET",
            "/api/v3/ticker/price",
            { symbol },
            false,
          ),
        ).price;
    },
    async place(order, quoteBudget) {
      const raw = await transport.request("POST", "/api/v3/order", {
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
    },
    async readTrades(symbol, from, to, fetchPage) {
      const binanceSchema = z
        .object({
          id: numericId,
          orderId: numericId,
          symbol: z.literal(symbol),
          isBuyer: z.boolean(),
          time: tradeTime,
          qty: positive,
          price: positive,
          quoteQty: positive,
          commission: decimal,
          commissionAsset: z.string().min(1),
        })
        .passthrough();
      const collected: PlatformTrade[] = [];
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
      return collected;
    },
    async readOrder(order) {
      let raw: unknown;
      try {
        raw = await transport.request("GET", "/api/v3/order", {
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
      const state = found.status;
      const executedQuantity = found.executedQty;
      const exchangeId = found.orderId;
      const fills: Fill[] = [];
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
            await transport.request("GET", "/api/v3/myTrades", {
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
      return { state, executedQuantity, exchangeId, fills, raw };
    },
    async cancel(order) {
      await transport.request("DELETE", "/api/v3/order", {
        symbol: order.symbol,
        origClientOrderId: order.clientId,
      });
    },
  };
}
