import { z } from "zod";
import type { Bar } from "~/lib/domain";
import {
  chartPeriodSchema,
  isMinutePeriod,
  type ChartPeriod,
} from "~/lib/chart/chart-view";
import {
  futuresContract,
  futuresContracts,
  futuresSymbolSchema,
} from "~/lib/market/futures";
import {
  outboundFetch,
  routeLabel,
  type OutboundOptions,
} from "../../infra/outbound";

export const YAHOO_FUTURES_VERSION = "yahoo-futures-1";
const ENDPOINT = "https://query1.finance.yahoo.com/v8/finance/chart/";
const HEADERS = { "User-Agent": "Mozilla/5.0" };
const DAY_S = 86400;

const interval: Record<ChartPeriod, string> = {
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "60m": "60m",
  day: "1d",
  week: "1wk",
  month: "1mo",
};
const seconds: Record<ChartPeriod, number> = {
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "60m": 3600,
  day: DAY_S,
  week: 7 * DAY_S,
  month: 31 * DAY_S,
};
/** Yahoo's intraday history limits: <1h about 60 days, 60m about 730 days. */
const lookback = (period: ChartPeriod) =>
  period === "60m" ? 729 * DAY_S : isMinutePeriod(period) ? 59 * DAY_S : null;

const numbers = z.array(z.number().nullable());
const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string(),
            gmtoffset: z.number(),
            regularMarketPrice: z.number().optional(),
            regularMarketChangePercent: z.number().optional(),
            regularMarketTime: z.number().optional(),
          }),
          timestamp: z.array(z.number()).default([]),
          indicators: z.object({
            quote: z
              .array(
                z.object({
                  open: numbers.default([]),
                  high: numbers.default([]),
                  low: numbers.default([]),
                  close: numbers.default([]),
                  volume: numbers.default([]),
                }),
              )
              .length(1),
          }),
        }),
      )
      .length(1),
  }),
});

const beijing = (t: number) =>
  new Date(t * 1000 + 8 * 3600000).toISOString().slice(0, 16) + ":00+08:00";

/**
 * Parse a Yahoo chart response. Daily and longer bars are labelled with the
 * exchange-local trade date; minute bars with their Beijing end time, like
 * the Eastmoney source. Empty rows (Yahoo pads closed sessions with nulls)
 * and inconsistent rows are dropped and listed, never filled.
 */
export function parseYahooChart(
  raw: unknown,
  yahooSymbol: string,
  period: ChartPeriod,
  now = Date.now(),
) {
  const checked = chartSchema.safeParse(raw);
  if (!checked.success) throw new Error("Yahoo 未返回有效行情");
  const [result] = checked.data.chart.result;
  if (result!.meta.symbol !== yahooSymbol)
    throw new Error("Yahoo 行情代码不匹配");
  const { timestamp, indicators, meta } = result!;
  const q = indicators.quote[0]!;
  const minute = isMinutePeriod(period);
  const bars: Bar[] = [];
  const excluded: { date: string; reason: string }[] = [];
  const formingDates: string[] = [];
  timestamp.forEach((t, i) => {
    const date = minute
      ? beijing(t + seconds[period])
      : new Date((t + meta.gmtoffset) * 1000).toISOString().slice(0, 10);
    const [open, high, low, close] = [
      q.open[i],
      q.high[i],
      q.low[i],
      q.close[i],
    ];
    const volume = q.volume[i] ?? 0;
    if (open == null || high == null || low == null || close == null) {
      // Closed-session padding is routine for intraday bars; not worth listing.
      if (!minute) excluded.push({ date, reason: "Yahoo 空行" });
      return;
    }
    const reason =
      bars.length && date <= bars.at(-1)!.date
        ? "日期重复或倒序"
        : ![open, high, low, close].every((v) => Number.isFinite(v) && v > 0) ||
            !(volume >= 0) ||
            high < Math.max(open, close) ||
            low > Math.min(open, close)
          ? "Yahoo OHLC 不自洽"
          : null;
    if (reason) return void excluded.push({ date, reason });
    bars.push({ date, open, high, low, close, volume, amount: 0 });
    if ((t + seconds[period]) * 1000 > now) formingDates.push(date);
  });
  if (!bars.length) throw new Error("Yahoo 没有有效 K 线");
  return {
    bars,
    excluded,
    formingDates,
    quote:
      meta.regularMarketPrice && meta.regularMarketPrice > 0
        ? {
            close: meta.regularMarketPrice,
            changePct: meta.regularMarketChangePercent ?? null,
            time: meta.regularMarketTime ? meta.regularMarketTime * 1000 : null,
          }
        : null,
  };
}

const inputSchema = z
  .object({
    symbol: futuresSymbolSchema,
    period: chartPeriodSchema,
    limit: z.number().int().min(1).max(20000).default(2000),
  })
  .strict();

async function fetchChart(
  yahooSymbol: string,
  params: Record<string, string>,
  options: OutboundOptions,
) {
  const url = new URL(`${ENDPOINT}${encodeURIComponent(yahooSymbol)}`);
  url.search = new URLSearchParams(params).toString();
  const { response, route } = await outboundFetch(
    url.toString(),
    { headers: HEADERS },
    { proxyOnStatus: [403, 451], ...options },
  );
  if (!response.ok) throw new Error(`Yahoo HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 16 * 1024 * 1024) throw new Error("Yahoo 响应超过读取上限");
  return { raw: JSON.parse(text) as unknown, route };
}

export async function yahooFuturesKlines(
  input: z.input<typeof inputSchema>,
  options: OutboundOptions & { now?: () => number } = {},
) {
  const { symbol, period, limit } = inputSchema.parse(input);
  const yahoo = futuresContract(symbol)?.yahoo;
  if (!yahoo) throw new Error("该品种没有 Yahoo 代码");
  const now = (options.now ?? Date.now)();
  const end = Math.floor(now / 1000) + DAY_S;
  const back = lookback(period);
  // Explicit period1/period2: `range=max` silently downsamples daily bars.
  const { raw, route } = await fetchChart(
    yahoo,
    {
      period1: String(back ? end - DAY_S - back : 0),
      period2: String(end),
      interval: interval[period],
      includePrePost: "false",
    },
    options,
  );
  const parsed = parseYahooChart(raw, yahoo, period, now);
  const bars = parsed.bars.slice(-limit);
  const first = bars[0]!.date;
  return {
    version: YAHOO_FUTURES_VERSION,
    source: "yahoo-futures",
    sourceUrl: `${ENDPOINT}${yahoo}`,
    bars,
    excluded: parsed.excluded.filter((e) => e.date >= first),
    formingDates: parsed.formingDates.filter((d) => d >= first),
    historyExhausted: parsed.bars.length <= limit,
    sourceNote: `${YAHOO_FUTURES_VERSION}；Yahoo ${yahoo} 近月连续合约，不复权、未做换月调整；日线按交易所当地交易日，分钟线按北京时间结束时刻；${routeLabel(route)}`,
  };
}

/** Latest price per foreign contract (Yahoo has no key-free batch quote). */
export async function yahooFuturesQuotes(options: OutboundOptions = {}) {
  const now = Date.now();
  return Promise.all(
    futuresContracts
      .filter((c) => c.yahoo)
      .map(async (c) => {
        try {
          const { raw } = await fetchChart(
            c.yahoo!,
            { range: "5d", interval: "1d" },
            options,
          );
          const { quote } = parseYahooChart(raw, c.yahoo!, "day", now);
          if (!quote) return { symbol: c.symbol, error: "无报价" };
          return { symbol: c.symbol, ...quote };
        } catch (error) {
          return {
            symbol: c.symbol,
            error: error instanceof Error ? error.message : "读取失败",
          };
        }
      }),
  );
}
