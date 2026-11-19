import Big from "big.js";
import { z } from "zod";
import type { PlatformTrade } from "../account-model";
import { type Symbol } from "../model";

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

const pair = (symbol: Symbol) => symbol.replace("USDT", "-USDT");

export function okxOperations(
  transport: SimulatedSpotTransport,
): VenueOperations {
  async function collectOkx(
    path: string,
    params: Record<string, string>,
    cursorField: string,
  ) {
    const result: Record<string, unknown>[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const batch = rows.parse(
        await transport.request("GET", path, {
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
  return {
    async snapshot() {
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
        .parse(await transport.request("GET", "/api/v5/account/balance", {}));
      const pending = await collectOkx(
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
    },
    async rules(symbol) {
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
          await transport.request(
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
    },
    async candles(symbol, minutes, limit) {
      const result = z.array(z.array(z.string()).min(9)).parse(
        await transport.request(
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
      return result
        .filter((x) => x[8] === "1")
        .map((x) => ({ time: Number(x[0]), close: Number(x[4]) }));
    },
    async price(symbol) {
      return z
        .array(z.object({ last: positive }))
        .min(1)
        .parse(
          await transport.request(
            "GET",
            "/api/v5/market/ticker",
            { instId: pair(symbol) },
            false,
          ),
        )[0]!.last;
    },
    async place(order, quoteBudget) {
      const raw = await transport.request("POST", "/api/v5/trade/order", {
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
    },
    async readTrades(symbol, from, to, fetchPage) {
      const okxSchema = z
        .object({
          tradeId: identifier,
          billId: numericId,
          ordId: identifier,
          instId: z.literal(pair(symbol)),
          instType: z.literal("SPOT").optional(),
          clOrdId: z.string().optional(),
          side: z.enum(["buy", "sell"]),
          fillTime: tradeTime,
          ts: tradeTime,
          fillSz: positive,
          fillPx: positive,
          fee: decimal,
          feeCcy: z.string().min(1),
        })
        .passthrough();
      const collected: PlatformTrade[] = [];
      let after: string | undefined;
      // OKX filters record creation ts, not fillTime. Read through the current
      // observation time so a fill recorded after the requested end isn't lost.
      const recordEnd = Math.max(to, transport.now());
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
      return collected;
    },
    async readOrder(order) {
      let raw: unknown;
      try {
        raw = await transport.request("GET", "/api/v5/trade/order", {
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
      const state = found.state;
      const executedQuantity = found.accFillSz;
      const exchangeId = found.ordId;
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
          await collectOkx(
            "/api/v5/trade/fills-history",
            { instType: "SPOT", instId: pair(order.symbol), ordId: exchangeId },
            "billId",
          ),
        );
      const fills = trades
        .filter((x) => x.ordId === exchangeId)
        .map((x) => ({
          id: x.tradeId,
          quantity: x.fillSz,
          price: x.fillPx,
          fee: new Big(x.fee).neg().toFixed(),
          feeAsset: x.feeCcy,
        }));
      return { state, executedQuantity, exchangeId, fills, raw };
    },
    async cancel(order) {
      const raw = await transport.request(
        "POST",
        "/api/v5/trade/cancel-order",
        {
          instId: pair(order.symbol),
          clOrdId: order.clientId,
        },
      );
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
    },
  };
}
