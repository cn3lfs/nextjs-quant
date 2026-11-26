import { z } from "zod";
import { chinaDate } from "~/lib/market/security-trading-status";
import type { Venue } from "../crypto-trading/model";
import { venues } from "../data-sources/crypto-venues/venues";
import { emFetch } from "../data-sources/eastmoney/em-fetch";
import {
  BINANCE_MARKET_HOSTS,
  parseBinanceKlines,
} from "../data-sources/binance/binance-klines";

export type PipelineQuoteSnapshot = {
  symbol: string;
  openPrice: number | null;
  lastPrice: number | null;
  prevClose: number | null;
  upperLimit: number | null;
  lowerLimit: number | null;
  suspended: boolean;
  tradeDate?: string;
  source?: string;
  observedAt?: number;
  ttlMs?: number;
};

type QuoteResult = PipelineQuoteSnapshot | null;
type ReadQuote = (
  symbol: string,
  date: string,
) => QuoteResult | Promise<QuoteResult>;
export type PipelineQuoteReader = ReadQuote & {
  readChecked?: (
    symbol: string,
    date: string,
    venue?: Venue,
  ) => QuoteResult | Promise<QuoteResult>;
};
const replayQuotes = new WeakSet<PipelineQuoteSnapshot>();
export const defaultQuoteTtlMs = 5 * 60_000;
type Snapshot = PipelineQuoteSnapshot & {
  tradeDate: string;
  observedAt: number;
  source: string;
};
type ReaderOptions = {
  now?: () => number;
  ttlMs?: number;
  fetcher?: typeof fetch;
  venue?: Venue;
  /** Explicit replay source must supply unadjusted, dated prices and session state. */
  historicalReplay?: (symbol: string, date: string) => Promise<Snapshot | null>;
};

export function quoteTimeError(
  q: PipelineQuoteSnapshot,
  date: string,
  now: number,
  allowReplay = false,
) {
  if (q.tradeDate !== date) return "execution-quote-date-mismatch";
  if (
    q.observedAt !== undefined &&
    !Number.isFinite(new Date(q.observedAt).getTime())
  )
    return "stale-execution-quote";
  if (q.observedAt !== undefined) {
    const day = /^(sh|sz|bj)/i.test(q.symbol)
      ? chinaDate(q.observedAt)
      : new Date(q.observedAt).toISOString().slice(0, 10);
    if (day !== date) return "execution-quote-date-mismatch";
  }
  if (allowReplay && replayQuotes.has(q)) return null;
  const ttl = q.ttlMs ?? defaultQuoteTtlMs;
  if (
    q.observedAt !== undefined &&
    (!Number.isFinite(q.observedAt) ||
      !Number.isFinite(ttl) ||
      ttl <= 0 ||
      q.observedAt > now ||
      now - q.observedAt > ttl)
  )
    return "stale-execution-quote";
  return null;
}

const rawPrice = z.number().finite().positive();
const cnFields = z.object({
  f57: z.string(),
  f107: z.number(),
  f59: z.number().int().min(0).max(8),
  f86: z.number().int().positive(),
  f43: rawPrice,
  f60: rawPrice,
  f47: z.unknown(),
  f46: z.unknown(),
  f51: z.unknown(),
  f52: z.unknown(),
});

async function cnQuote(
  symbol: string,
  date: string,
  fetcher: typeof fetch,
  now: () => number,
): Promise<Snapshot | null> {
  const market = symbol.startsWith("sh") ? 1 : 0;
  const code = symbol.slice(2);
  const url = new URL("https://push2.eastmoney.com/api/qt/stock/get");
  url.search = new URLSearchParams({
    secid: market + "." + code,
    fltt: "1",
    fields: "f43,f46,f47,f51,f52,f57,f59,f60,f86,f107",
  }).toString();
  const response = await emFetch(url, {}, fetcher);
  if (!response.ok) return null;
  const parsed = cnFields.safeParse(
    ((await response.json()) as { data?: unknown }).data,
  );
  if (!parsed.success) return null;
  const row = parsed.data;
  if (row.f57 !== code || row.f107 !== market) return null;
  const observedAt = row.f86 * 1000;
  const scale = 10 ** row.f59;
  const price = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v / scale : null;
  // The quote endpoint supplies limits but no verified suspension flag. Require
  // an independent, same-security, same-session trading-state observation.
  const status = await fetcher("https://hq.sinajs.cn/list=" + symbol, {
    headers: { Referer: "https://finance.sina.com.cn/" },
    signal: AbortSignal.timeout(5000),
  });
  if (!status.ok) return null;
  const match = /^\s*var hq_str_((?:sh|sz|bj)\d{6})="([^"\r\n]*)";\s*$/.exec(
    await status.text(),
  );
  if (!match || match[1] !== symbol) return null;
  const f = match[2]!.split(",");
  if (f[30] !== date || !/^\d{2}:\d{2}:\d{2}$/.test(f[31] ?? "")) return null;
  // Only the normal trading code is eligible. All other state codes block execution.
  const stateTime = Date.parse(f[30] + "T" + f[31] + "+08:00");
  if (observedAt > now() || stateTime > now())
    throw new ExecutionQuoteError("stale-execution-quote");
  if (!Number.isFinite(stateTime) || !f[32]?.trim()) return null;
  const suspended = f[32].trim() !== "00";
  if (
    !suspended &&
    (!rawPrice.safeParse(row.f47).success || price(row.f46) === null)
  )
    return null;
  return {
    symbol,
    source: "eastmoney-raw+sina-status",
    tradeDate: chinaDate(observedAt),
    observedAt: Math.min(observedAt, stateTime),
    openPrice: price(row.f46),
    lastPrice: price(row.f43),
    prevClose: price(row.f60),
    upperLimit: price(row.f51),
    lowerLimit: price(row.f52),
    suspended,
  };
}

async function publicJson(url: string | URL, fetcher: typeof fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("missing-execution-quote");
  return response.json() as Promise<unknown>;
}

async function venueQuote(
  symbol: string,
  date: string,
  venue: "okx" | "bybit",
  fetcher: typeof fetch,
): Promise<Snapshot | null> {
  const spec = venues[venue];
  const pair = symbol.toUpperCase().replace(/^CX/, "");
  const inst = venue === "okx" ? pair.replace(/USDT$/, "-USDT") : pair;
  const start = Date.parse(date);
  const ok = venue === "okx";
  const [info, ticks, day] = await Promise.all([
    publicJson(
      spec.host +
        (ok
          ? "/api/v5/public/instruments?instType=SPOT&instId=" + inst
          : "/v5/market/instruments-info?category=spot&symbol=" + inst),
      fetcher,
    ),
    publicJson(
      spec.host +
        (ok
          ? "/api/v5/market/trades?limit=1&instId=" + inst
          : "/v5/market/recent-trade?limit=1&category=spot&symbol=" + inst),
      fetcher,
    ),
    publicJson(spec.url(inst, spec.interval("day")!, 1, "day", start), fetcher),
  ]);
  const previous = spec
    .parse(day)
    .find((row) => row.openTime === start - 86400000 && row.closed !== false);
  if (!previous || !Number.isFinite(previous.close) || previous.close <= 0)
    return null;
  const px = z.coerce.number().finite().positive(),
    ts = z.coerce.number().int().positive();
  const okxRows = <T extends z.ZodTypeAny>(row: T, data: unknown) =>
    z.object({ code: z.literal("0"), data: z.array(row).length(1) }).parse(data)
      .data[0] as z.output<T>;
  const bybitRows = <T extends z.ZodTypeAny>(row: T, data: unknown) =>
    z
      .object({
        retCode: z.literal(0),
        result: z.object({
          category: z.literal("spot"),
          list: z.array(row).length(1),
        }),
      })
      .parse(data).result.list[0] as z.output<T>;
  let lastPrice: number, observedAt: number, suspended: boolean;
  if (ok) {
    const instrument = okxRows(
      z.object({
        instId: z.literal(inst),
        instType: z.literal("SPOT"),
        state: z.string(),
      }),
      info,
    );
    const trade = okxRows(z.object({ instId: z.literal(inst), px, ts }), ticks);
    lastPrice = trade.px;
    observedAt = trade.ts;
    suspended = instrument.state !== "live";
  } else {
    const instrument = bybitRows(
      z.object({ symbol: z.literal(inst), status: z.string() }),
      info,
    );
    const trade = bybitRows(
      z.object({ symbol: z.literal(inst), price: px, time: ts }),
      ticks,
    );
    lastPrice = trade.price;
    observedAt = trade.time;
    suspended = instrument.status !== "Trading";
  }
  return {
    symbol,
    source: venue + "-spot",
    observedAt,
    tradeDate: new Date(observedAt).toISOString().slice(0, 10),
    lastPrice,
    openPrice: null,
    suspended,
    prevClose: previous.close,
    upperLimit: null,
    lowerLimit: null,
  };
}
async function cryptoQuote(
  symbol: string,
  date: string,
  fetcher: typeof fetch,
): Promise<Snapshot | null> {
  const pair = symbol.toUpperCase().replace(/^CX/, "");
  const get = (path: string) =>
    publicJson(BINANCE_MARKET_HOSTS[0] + "/api/v3/" + path, fetcher);
  const [info, trades, day] = await Promise.all([
    get("exchangeInfo?symbol=" + pair),
    get("trades?limit=1&symbol=" + pair),
    get(
      "klines?interval=1d&limit=1&symbol=" +
        pair +
        "&endTime=" +
        (Date.parse(date) - 1),
    ),
  ]);
  const [instrument] = z
    .object({
      symbols: z
        .array(z.object({ symbol: z.literal(pair), status: z.string() }))
        .length(1),
    })
    .parse(info).symbols;
  const [trade] = z
    .array(
      z.object({
        price: z.coerce.number().positive().finite(),
        time: z.number().int().positive(),
      }),
    )
    .length(1)
    .parse(trades);
  const [previous] = parseBinanceKlines(day, "day");
  if (previous?.closeTime !== Date.parse(date) - 1) return null;
  return {
    symbol,
    openPrice: null,
    lastPrice: trade!.price,
    prevClose: previous.bar.close,
    upperLimit: null,
    lowerLimit: null,
    suspended: instrument!.status !== "TRADING",
    source: "binance-spot",
    observedAt: trade!.time,
    tradeDate: new Date(trade!.time).toISOString().slice(0, 10),
  };
}

export class ExecutionQuoteError extends Error {}

/** Ordinary readers see null for unusable evidence. The executor also retains the rejection reason. */
export function createPipelineQuoteReader(options: ReaderOptions = {}) {
  const now = options.now ?? Date.now;
  async function readChecked(
    symbol: string,
    date: string,
    venue = options.venue ?? "binance",
  ) {
    const cn = /^(sh|sz|bj)\d{6}$/i.test(symbol);
    if (!cn && !/^(?:cx)?[a-z0-9]{1,20}usdt$/i.test(symbol)) return null;
    const today = cn
      ? chinaDate(now())
      : new Date(now()).toISOString().slice(0, 10);
    const historical = date < today && options.historicalReplay;
    if (date !== today && !historical) return null;
    const q = historical
      ? await historical(symbol, date)
      : cn
        ? await cnQuote(
            symbol.toLowerCase(),
            date,
            options.fetcher ?? fetch,
            now,
          )
        : venue === "binance"
          ? await cryptoQuote(symbol, date, options.fetcher ?? fetch)
          : await venueQuote(symbol, date, venue, options.fetcher ?? fetch);
    if (!q || q.symbol.toUpperCase() !== symbol.toUpperCase()) return null;
    const snapshot = { ...q, ttlMs: options.ttlMs ?? defaultQuoteTtlMs };
    const reason = quoteTimeError(
      snapshot,
      date,
      historical ? snapshot.observedAt : now(),
    );
    if (reason) throw new ExecutionQuoteError(reason);
    if (historical) replayQuotes.add(snapshot);
    return snapshot;
  }
  const reader = async (symbol: string, date: string) => {
    try {
      return await readChecked(symbol, date);
    } catch {
      return null;
    }
  };
  return Object.assign(reader, { readChecked });
}
