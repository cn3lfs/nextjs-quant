import { z } from "zod";
import type { Bar } from "~/lib/domain";
import type {
  ThsdkOrderBookItem,
  ThsdkOrderBookLevel,
  ThsdkOrderBooksResponse,
  ThsdkPriceVolumeResult,
  ThsdkCallAuctionResult,
  ThsdkIntradayResult,
  ThsdkCapitalFlowsResponse,
  ThsdkPopularityResult,
} from "~/lib/market/thsdk-reference";
import {
  decodeThsdkDayNumber,
  decodeThsdkPackedTime,
  fromThsdkSecurity,
  toThsdkSecurity,
  ThsdkError,
  type ThsdkSecurity,
  type ThsdkPeriodKey,
} from "./thsdk-contract";

export const THSDK_ADAPTER_VERSION = "thsdk-adapter-1";
const source = "thsdk-hq";
const positive = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const nullableAmount = nonnegative
  .nullish()
  .catch(null)
  .transform((value) => value ?? null);
const security = z.object({ market: z.string(), code: z.string() });
const identity = z.object({ security: security.optional() });

function header(fetchedAt: number) {
  return { source, version: THSDK_ADAPTER_VERSION, fetchedAt } as const;
}

function invalid(): never {
  throw new ThsdkError("invalid_response", "同花顺返回的数据格式或数值无效");
}

function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  raw: unknown,
): T {
  const result = schema.safeParse(raw);
  return result.success ? result.data : invalid();
}

// Price-volume rows can repeat the market prefix inside the code itself.
function rowSymbol(row: ThsdkSecurity) {
  const code = row.code.startsWith(row.market)
    ? row.code.slice(row.market.length)
    : row.code;
  return fromThsdkSecurity({ market: row.market, code });
}

function checkIdentity(row: ThsdkSecurity | undefined, symbol: string) {
  if (row && rowSymbol(row) !== symbol.trim().toLowerCase()) invalid();
}

function byRequestedSymbol<T extends { security: ThsdkSecurity }>(
  rows: T[],
  requested: string[],
) {
  const bySymbol = new Map<string, T>();
  for (const row of rows) {
    const key = rowSymbol(row.security);
    if (!key || bySymbol.has(key)) invalid();
    bySymbol.set(key, row);
  }
  return requested.map((symbol) => ({
    symbol,
    row: bySymbol.get(symbol.trim().toLowerCase()),
  }));
}

export function thsdkVolumeUnit(
  symbol: string,
): ThsdkOrderBookItem["volumeUnit"] {
  switch (toThsdkSecurity(symbol).market) {
    case "USHJ":
    case "USZJ":
      return "份";
    case "USHA":
    case "USZA":
    case "USTA":
      return "股";
    case "USHI":
    case "USZI":
    case "URFI":
      return "指数源字段";
    default:
      return "源单位未独立核验";
  }
}

const kline = z.object({
  time: z.number().int(),
  open: positive,
  high: positive,
  low: positive,
  close: positive,
  volume: nonnegative,
  turnover: nonnegative,
});

export function mapThsdkKlines(
  raw: unknown,
  period: Exclude<ThsdkPeriodKey, "quarter" | "year">,
): Bar[] {
  const decode = period.endsWith("m")
    ? decodeThsdkPackedTime
    : decodeThsdkDayNumber;
  let previous = "";
  return parse(z.array(kline), raw).map(
    ({ time, open, high, low, close, volume, turnover }) => {
      const date = decode(time);
      if (
        date <= previous ||
        low > Math.min(open, close) ||
        high < Math.max(open, close)
      )
        invalid();
      previous = date;
      return { date, open, high, low, close, volume, amount: turnover };
    },
  );
}

const book = z.object({ security, bids: z.unknown(), asks: z.unknown() });
const bookSide = z.array(z.unknown()).max(5);
const slot = z.object({ price: nullableAmount, volume: nullableAmount });

function bookLevels(raw: unknown): ThsdkOrderBookLevel[] {
  const side = bookSide.safeParse(raw);
  return Array.from({ length: 5 }, (_, i) => {
    const parsed = slot.safeParse(side.data?.[i]);
    const { price, volume } = parsed.data ?? { price: null, volume: null };
    let state: ThsdkOrderBookLevel["state"] = "unknown";
    if (price === 0 && volume === 0) state = "empty";
    else if (price !== null && volume !== null && price > 0 && volume > 0)
      state = "quoted";
    return { level: i + 1, price, volume, state };
  });
}

export function mapThsdkOrderBooks(
  raw: unknown,
  requestedSymbols: string[],
  fetchedAt: number,
): ThsdkOrderBooksResponse {
  const rows = byRequestedSymbol(parse(z.array(book), raw), requestedSymbols);
  return {
    ...header(fetchedAt),
    items: rows.map(({ symbol, row }) => {
      const bids = bookLevels(row?.bids);
      const asks = bookLevels(row?.asks);
      const levels = [...bids, ...asks];
      let status: ThsdkOrderBookItem["status"] = "invalid";
      if (!row) status = "unavailable";
      else if (levels.some((level) => level.state === "quoted")) status = "ok";
      else if (levels.every((level) => level.state === "empty"))
        status = "empty";
      return {
        symbol,
        status,
        bids,
        asks,
        volumeUnit: thsdkVolumeUnit(symbol),
        fetchedAt,
        dataAsOf: null,
        delayed: "unverified",
      };
    }),
  };
}

const priceLevel = identity.extend({
  price: positive,
  volume: nonnegative,
  in_volume: nullableAmount,
  out_volume: nullableAmount,
  transaction_count: nullableAmount,
  out_volume_rate: nullableAmount,
});

export function mapThsdkPriceVolumeLevels(
  raw: unknown,
  symbol: string,
  fetchedAt: number,
): ThsdkPriceVolumeResult {
  const levels = parse(z.array(priceLevel), raw).map((row) => {
    checkIdentity(row.security, symbol);
    return {
      price: row.price,
      volume: row.volume,
      inVolume: row.in_volume,
      outVolume: row.out_volume,
      transactionCount: row.transaction_count,
      outVolumeRate: row.out_volume_rate,
    };
  });
  return {
    ...header(fetchedAt),
    symbol,
    dataAsOf: null,
    volumeUnit: thsdkVolumeUnit(symbol),
    levels,
  };
}

const auctionPoint = z.object({
  time: z.number().int().nonnegative().max(253402271999),
  price: positive,
  cur_volume: nonnegative,
  bid2_vol: nullableAmount,
  ask2_vol: nullableAmount,
});

export function mapThsdkCallAuction(
  raw: unknown,
  symbol: string,
  phase: "opening" | "closing",
  date: string,
  fetchedAt: number,
): ThsdkCallAuctionResult {
  const points = parse(z.array(auctionPoint), raw).map((row) => {
    const timestamp = row.time * 1000;
    const time =
      new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19) + "+08:00";
    if (time.slice(0, 10) !== date) invalid();
    return {
      time,
      timestamp,
      price: row.price,
      curVolume: row.cur_volume,
      bid2Vol: row.bid2_vol,
      ask2Vol: row.ask2_vol,
    };
  });
  return { ...header(fetchedAt), symbol, phase, date, points };
}

const minutePoint = z.object({
  time: z.number().int(),
  price: positive,
  volume: nonnegative,
  turnover: nonnegative,
});

export function mapThsdkIntraday(
  raw: unknown,
  symbol: string,
  date: string | null | undefined,
  fetchedAt: number,
): ThsdkIntradayResult {
  let tradeDate = date ?? null;
  let previous = "";
  const points = parse(z.array(minutePoint), raw).map((row) => {
    const time = decodeThsdkPackedTime(row.time);
    tradeDate ??= time.slice(0, 10);
    if (time.slice(0, 10) !== tradeDate || time <= previous) invalid();
    previous = time;
    return {
      time,
      price: row.price,
      volume: row.volume,
      turnover: row.turnover,
    };
  });
  return {
    ...header(fetchedAt),
    symbol,
    date: tradeDate,
    volumeUnit: thsdkVolumeUnit(symbol),
    points,
  };
}

const flow = z.object({
  security,
  turnover: nullableAmount,
  active_buy_x_large: nullableAmount,
  active_sell_x_large: nullableAmount,
  active_buy_large: nullableAmount,
  active_sell_large: nullableAmount,
  passive_buy_x_large: nullableAmount,
  passive_sell_x_large: nullableAmount,
  passive_buy_large: nullableAmount,
  passive_sell_large: nullableAmount,
  active_buy_medium: nullableAmount,
  active_sell_medium: nullableAmount,
  passive_buy_medium: nullableAmount,
  passive_sell_medium: nullableAmount,
  active_buy_small: nullableAmount,
  active_sell_small: nullableAmount,
});

function mainNet(row?: z.infer<typeof flow>) {
  if (!row) return null;
  const buys = [
    row.active_buy_x_large,
    row.active_buy_large,
    row.passive_buy_x_large,
    row.passive_buy_large,
  ];
  const sells = [
    row.active_sell_x_large,
    row.active_sell_large,
    row.passive_sell_x_large,
    row.passive_sell_large,
  ];
  if (!buys.every((n) => n !== null) || !sells.every((n) => n !== null))
    return null;
  const net =
    buys.reduce((a, b) => a + b, 0) - sells.reduce((a, b) => a + b, 0);
  return Number.isFinite(net) ? net : null;
}

export function mapThsdkDailyCapitalFlows(
  raw: unknown,
  requestedSymbols: string[],
  fetchedAt: number,
): ThsdkCapitalFlowsResponse {
  const rows = byRequestedSymbol(parse(z.array(flow), raw), requestedSymbols);
  return {
    ...header(fetchedAt),
    items: rows.map(({ symbol, row }) => ({
      symbol,
      source,
      fetchedAt,
      turnover: row?.turnover ?? null,
      activeBuyXLarge: row?.active_buy_x_large ?? null,
      activeSellXLarge: row?.active_sell_x_large ?? null,
      activeBuyLarge: row?.active_buy_large ?? null,
      activeSellLarge: row?.active_sell_large ?? null,
      passiveBuyXLarge: row?.passive_buy_x_large ?? null,
      passiveSellXLarge: row?.passive_sell_x_large ?? null,
      passiveBuyLarge: row?.passive_buy_large ?? null,
      passiveSellLarge: row?.passive_sell_large ?? null,
      activeBuyMedium: row?.active_buy_medium ?? null,
      activeSellMedium: row?.active_sell_medium ?? null,
      passiveBuyMedium: row?.passive_buy_medium ?? null,
      passiveSellMedium: row?.passive_sell_medium ?? null,
      activeBuySmall: row?.active_buy_small ?? null,
      activeSellSmall: row?.active_sell_small ?? null,
      mainNetInflow: mainNet(row),
    })),
  };
}

const popularity = identity.extend({
  status_code: z.literal(0).optional(),
  rank_info: z.object({
    rank: z.number().int().positive().nullish(),
    rank_amount: z.number().int().nonnegative().nullish(),
    rank_change: z.number().int().nullish(),
  }),
});

export function mapThsdkPopularityRank(
  raw: unknown,
  symbol: string,
  fetchedAt: number,
): ThsdkPopularityResult {
  const row = parse(popularity, raw);
  checkIdentity(row.security, symbol);
  return {
    ...header(fetchedAt),
    symbol,
    rank: row.rank_info.rank ?? null,
    rankAmount: row.rank_info.rank_amount ?? null,
    rankChange: row.rank_info.rank_change ?? null,
  };
}
