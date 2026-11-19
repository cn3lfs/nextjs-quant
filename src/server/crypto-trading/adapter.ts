import Big from "big.js";
import { z } from "zod";
import type { AccountHistoryAdapter, PlatformTrade } from "./account-model";
import { type OutboundOptions } from "../infra/outbound";
import {
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

import { binanceOperations } from "./adapters/binance";
import { okxOperations } from "./adapters/okx";
import { bybitOperations } from "./adapters/bybit";
import {
  ExchangeError,
  positive,
  SimulatedSpotTransport,
  type VenueOperations,
} from "./adapters/types";

export { ExchangeError };

const checkedSymbol = (symbol: Symbol) =>
  z.enum(["BTCUSDT", "ETHUSDT"]).parse(symbol);

const venues = {
  binance: binanceOperations,
  okx: okxOperations,
  bybit: bybitOperations,
};

export class SimulatedSpotAdapter implements AccountHistoryAdapter {
  private readonly transport: SimulatedSpotTransport;
  private readonly venue: VenueOperations;

  constructor(
    config: Config,
    credential: Credential,
    options: OutboundOptions = {},
  ) {
    this.transport = new SimulatedSpotTransport(config, credential, options);
    this.venue = venues[this.transport.venue](this.transport);
  }

  snapshot(): Promise<Snapshot> {
    return this.venue.snapshot();
  }
  async rules(symbol: Symbol): Promise<Rules> {
    checkedSymbol(symbol);

    return this.venue.rules(symbol);
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
    await this.transport.clock();

    const candles = await this.venue.candles(symbol, minutes, limit);
    candles.sort((a, b) => a.time - b.time);
    for (let i = 0; i < candles.length; i++) {
      const item = candles[i]!;
      if (
        !Number.isSafeInteger(item.time) ||
        !Number.isFinite(item.close) ||
        item.close <= 0 ||
        item.time + minutes * 60_000 > this.transport.serverNow()
      )
        throw new Error("无效或未完成K线");
      if (i > 0 && item.time - candles[i - 1]!.time !== minutes * 60_000)
        throw new Error("K线存在重复或缺口");
    }
    return candles.slice(-limit);
  }
  async price(symbol: Symbol): Promise<string> {
    checkedSymbol(symbol);

    return this.venue.price(symbol);
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

    return this.venue.place(order, quoteBudget);
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
    let requests = 0;
    const fetchPage = async (path: string, params: Record<string, string>) => {
      if (++requests > 1000)
        throw new Error("成交历史分页超出安全上限，范围不完整");
      return this.transport.historyPage(path, params);
    };

    const collected = await this.venue.readTrades(symbol, from, to, fetchPage);
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

    const found = await this.venue.readOrder(order);
    if (!found) return null;
    const { state, executedQuantity, exchangeId, raw } = found;
    const unique = new Map<string, Fill>();
    for (const fill of found.fills) {
      const previous = unique.get(fill.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(fill))
        throw new Error("同一成交编号内容不一致");
      unique.set(fill.id, fill);
    }
    const fills = [...unique.values()];
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

    await this.venue.cancel(order);
  }
}
export const createSpotAdapter = (
  config: Config,
  credential: Credential,
): AccountHistoryAdapter => new SimulatedSpotAdapter(config, credential);
