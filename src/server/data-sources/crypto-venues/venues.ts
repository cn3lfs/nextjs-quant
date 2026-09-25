import { z } from "zod";
import type { ChartPeriod } from "~/lib/chart/chart-view";
import { periodSeconds, type VenueRow, type VenueSpec } from "./venue-klines";

const num = z.union([z.string(), z.number()]).transform(Number);
const table =
  <T extends string>(map: Partial<Record<ChartPeriod, T>>) =>
  (period: ChartPeriod) =>
    map[period] ?? null;

/**
 * OKX history-candles: newest first, `after` returns strictly older rows,
 * 300 per page. `1Dutc`-style bars cut days at UTC midnight (plain `1D` uses
 * Hong Kong time). Row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
 */
export const okx: VenueSpec = {
  id: "okx",
  name: "OKX",
  version: "okx-candles-1",
  host: "https://www.okx.com",
  pageSize: 300,
  interval: table({
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "60m": "1H",
    day: "1Dutc",
    week: "1Wutc",
    month: "1Mutc",
  }),
  url: (pair, interval, size, _period, before) => {
    const url = new URL("/api/v5/market/history-candles", okx.host);
    url.search = new URLSearchParams({
      instId: pair,
      bar: interval,
      limit: String(size),
      ...(before !== undefined ? { after: String(before) } : {}),
    }).toString();
    return url;
  },
  parse: (raw) => {
    const body = z
      .object({
        code: z.string(),
        msg: z.string().optional(),
        data: z.array(z.array(z.string()).min(9)),
      })
      .parse(raw);
    if (body.code !== "0") throw new Error(`OKX：${body.msg || body.code}`);
    return body.data.map(
      ([ts, o, h, l, c, vol, , quote, confirm]): VenueRow => ({
        openTime: Number(ts),
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(c),
        volume: Number(vol),
        amount: Number(quote),
        closed: confirm === "1",
      }),
    );
  },
};

/**
 * Gate.io: oldest first; `to` (seconds) is inclusive. Only the latest 10000
 * points are served, so that error ends paging. Weekly/monthly buckets are
 * not calendar aligned and are not offered. Row: [t, quoteVol, c, h, l, o,
 * baseVol, closed].
 */
export const gate: VenueSpec = {
  id: "gate",
  name: "Gate.io",
  version: "gate-candlesticks-1",
  host: "https://api.gateio.ws",
  pageSize: 1000,
  interval: table({
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "60m": "1h",
    day: "1d",
  }),
  url: (pair, interval, size, _period, before) => {
    const url = new URL("/api/v4/spot/candlesticks", gate.host);
    url.search = new URLSearchParams({
      currency_pair: pair,
      interval,
      limit: String(size),
      ...(before !== undefined
        ? { to: String(Math.floor(before / 1000) - 1) }
        : {}),
    }).toString();
    return url;
  },
  parse: (raw) => {
    const rows = z
      .array(z.tuple([num, num, num, num, num, num, num]).rest(z.unknown()))
      .safeParse(raw);
    if (!rows.success) {
      const error = z.object({ message: z.string() }).safeParse(raw);
      throw new Error(
        `Gate.io：${error.success ? error.data.message : "未返回有效 K 线"}`,
      );
    }
    return rows.data.map((row): VenueRow => {
      const [t, quote, c, h, l, o, base, closed] = row;
      return {
        openTime: t * 1000,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: base,
        amount: quote,
        closed:
          closed === undefined ? undefined : String(closed) === "true",
      };
    });
  },
  exhausted: (message) => message.includes("Maximum 10000 points"),
  note: "Gate.io 只提供最近 10000 根",
};

/**
 * Coinbase Exchange: newest first, at most 300 rows; start/end are both
 * required. Only 5m/15m/1h/1d granularities exist among chart periods. Row:
 * [time, low, high, open, close, volume]; no quote volume.
 */
export const coinbase: VenueSpec = {
  id: "coinbase",
  name: "Coinbase",
  version: "coinbase-candles-1",
  host: "https://api.exchange.coinbase.com",
  pageSize: 300,
  interval: table({ "5m": "300", "15m": "900", "60m": "3600", day: "86400" }),
  url: (pair, interval, size, period, before) => {
    const step = periodSeconds(period) * 1000;
    // Windows tile backwards from `before`, so a gap never re-reads a window.
    const end = before ?? Math.floor(Date.now() / step) * step + step;
    const url = new URL(`/products/${pair}/candles`, coinbase.host);
    url.search = new URLSearchParams({
      granularity: interval,
      start: new Date(end - size * step).toISOString(),
      end: new Date(end - 1000).toISOString(),
    }).toString();
    return url;
  },
  parse: (raw) => {
    const rows = z.array(z.tuple([num, num, num, num, num, num])).safeParse(raw);
    if (!rows.success) {
      const error = z.object({ message: z.string() }).safeParse(raw);
      throw new Error(
        `Coinbase：${error.success ? error.data.message : "未返回有效 K 线"}`,
      );
    }
    return rows.data.map(
      ([t, low, high, open, close, volume]): VenueRow => ({
        openTime: t * 1000,
        open,
        high,
        low,
        close,
        volume,
        amount: null,
      }),
    );
  },
  shortPages: true,
  note: "Coinbase 不提供成交额（记 0）",
};

/**
 * Bybit v5 spot: newest first; `end` (ms) is inclusive, 1000 per page.
 * Row: [start, o, h, l, c, volume, turnover].
 */
export const bybit: VenueSpec = {
  id: "bybit",
  name: "Bybit",
  version: "bybit-kline-1",
  host: "https://api.bybit.com",
  pageSize: 1000,
  interval: table({
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "60m": "60",
    day: "D",
    week: "W",
    month: "M",
  }),
  url: (pair, interval, size, _period, before) => {
    const url = new URL("/v5/market/kline", bybit.host);
    url.search = new URLSearchParams({
      category: "spot",
      symbol: pair,
      interval,
      limit: String(size),
      ...(before !== undefined ? { end: String(before - 1) } : {}),
    }).toString();
    return url;
  },
  parse: (raw) => {
    const body = z
      .object({
        retCode: z.number(),
        retMsg: z.string().optional(),
        result: z
          .object({ list: z.array(z.array(z.string()).min(7)) })
          .optional(),
      })
      .parse(raw);
    if (body.retCode !== 0 || !body.result)
      throw new Error(`Bybit：${body.retMsg || body.retCode}`);
    return body.result.list.map(
      ([t, o, h, l, c, vol, turnover]): VenueRow => ({
        openTime: Number(t),
        open: Number(o),
        high: Number(h),
        low: Number(l),
        close: Number(c),
        volume: Number(vol),
        amount: Number(turnover),
      }),
    );
  },
};

export const venues = { okx, gate, coinbase, bybit } as const;
