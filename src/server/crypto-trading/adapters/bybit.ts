import Big from "big.js";
import { z } from "zod";
import type { PlatformTrade } from "../account-model";

import {
  decimal,
  positive,
  nonnegative,
  identifier,
  rows,
  tradeTime,
  type SimulatedSpotTransport,
  type VenueOperations,
} from "./types";

export function bybitOperations(
  transport: SimulatedSpotTransport,
): VenueOperations {
  async function collectBybit(path: string, params: Record<string, string>) {
    const result: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const batch = z
        .object({ list: rows, nextPageCursor: z.string().optional() })
        .parse(
          await transport.request("GET", path, {
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
  return {
    async snapshot() {
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
          await transport.request("GET", "/v5/account/wallet-balance", {
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
        openOrders: await collectBybit("/v5/order/realtime", {
          category: "spot",
          openOnly: "0",
        }),
      };
    },
    async rules(symbol) {
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
          await transport.request(
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
    },
    async candles(symbol, minutes, limit) {
      const result = z
        .object({ list: z.array(z.array(z.string()).min(7)) })
        .parse(
          await transport.request(
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
      return result.list
        .filter((x) => Number(x[0]) + minutes * 60_000 <= transport.serverNow())
        .map((x) => ({ time: Number(x[0]), close: Number(x[4]) }));
    },
    async price(symbol) {
      return z
        .object({ list: z.array(z.object({ lastPrice: positive })).min(1) })
        .parse(
          await transport.request(
            "GET",
            "/v5/market/tickers",
            { category: "spot", symbol },
            false,
          ),
        ).list[0]!.lastPrice;
    },
    async place(order, quoteBudget) {
      const raw = await transport.request("POST", "/v5/order/create", {
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
    },
    async readTrades(symbol, from, to, fetchPage) {
      const bybitSchema = z
        .object({
          execId: identifier,
          orderId: identifier,
          orderLinkId: z.string().optional(),
          symbol: z.literal(symbol),
          side: z.enum(["Buy", "Sell"]),
          execTime: tradeTime,
          execQty: positive,
          execPrice: positive,
          execValue: positive,
          execFee: decimal,
          feeCurrency: z.string().min(1),
          extraFees: z.literal("").optional(),
        })
        .passthrough();
      const collected: PlatformTrade[] = [];
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
      return collected;
    },
    async readOrder(order) {
      let foundRows = await collectBybit("/v5/order/realtime", {
        category: "spot",
        symbol: order.symbol,
        orderLinkId: order.clientId,
      });
      if (!foundRows.length)
        foundRows = await collectBybit("/v5/order/history", {
          category: "spot",
          symbol: order.symbol,
          orderLinkId: order.clientId,
        });
      if (!foundRows.length) return null;
      const raw = foundRows;
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
      const state = found.orderStatus;
      const executedQuantity = found.cumExecQty;
      const exchangeId = found.orderId;
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
          await collectBybit("/v5/execution/list", {
            category: "spot",
            symbol: order.symbol,
            orderId: exchangeId,
          }),
        );
      const fills = trades
        .filter((x) => x.orderId === exchangeId)
        .map((x) => ({
          id: x.execId,
          quantity: x.execQty,
          price: x.execPrice,
          fee: x.execFee,
          feeAsset: x.feeCurrency,
        }));
      return { state, executedQuantity, exchangeId, fills, raw };
    },
    async cancel(order) {
      await transport.request("POST", "/v5/order/cancel", {
        category: "spot",
        symbol: order.symbol,
        orderLinkId: order.clientId,
      });
    },
  };
}
