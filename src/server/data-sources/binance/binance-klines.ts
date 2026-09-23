import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { chartPeriodSchema, type ChartPeriod } from "~/lib/chart/chart-view";
import {
  binanceInterval,
  cryptoBarDate,
  cryptoPair,
  cryptoSymbolSchema,
} from "~/lib/market/crypto";
import {
  outboundFetch,
  routeLabel,
  type OutboundOptions,
  type OutboundRoute,
} from "../../infra/outbound";

export const BINANCE_KLINES_VERSION = "binance-klines-1";
/** Public market data only; no key. The vision host serves market data only. */
export const BINANCE_MARKET_HOSTS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
] as const;
const PAGE = 1000;

const inputSchema = z
  .object({
    symbol: cryptoSymbolSchema,
    period: chartPeriodSchema,
    limit: z.number().int().min(1).max(5000).default(2000),
  })
  .strict();

const kline = z
  .tuple([
    z.number(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.string(),
    z.number(),
    z.string(),
  ])
  .rest(z.unknown());

/** Parse one klines page; rejects malformed rows instead of repairing them. */
export function parseBinanceKlines(raw: unknown, period: ChartPeriod) {
  const rows = z.array(kline).safeParse(raw);
  if (!rows.success) throw new Error("币安未返回有效 K 线");
  return rows.data.map((row) => {
    const [openTime, o, h, l, c, v, closeTime, quote] = row;
    const [open, high, low, close, volume, amount] = [o, h, l, c, v, quote].map(
      Number,
    ) as [number, number, number, number, number, number];
    if (
      ![open, high, low, close].every((x) => Number.isFinite(x) && x > 0) ||
      ![volume, amount].every((x) => Number.isFinite(x) && x >= 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      closeTime <= openTime
    )
      throw new Error("币安 K 线价格或时间无效");
    return {
      openTime,
      closeTime,
      bar: {
        date: cryptoBarDate(openTime, closeTime, period),
        open,
        high,
        low,
        close,
        volume,
        amount,
      } satisfies Bar,
    };
  });
}

type Page = ReturnType<typeof parseBinanceKlines>;
/** Join pages fetched newest-first into one ascending, de-duplicated series. */
export function mergeKlinePages(pages: Page[]) {
  const byOpen = new Map<number, Page[number]>();
  for (const page of pages)
    for (const row of page) byOpen.set(row.openTime, row);
  return [...byOpen.values()].sort((a, b) => a.openTime - b.openTime);
}

async function readJson(response: Response) {
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `币安 HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ""}`,
    );
  }
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error("币安响应超过读取上限");
  return JSON.parse(text) as unknown;
}

export async function binanceKlines(
  input: z.input<typeof inputSchema>,
  options: OutboundOptions & { now?: () => number } = {},
) {
  const { symbol, period, limit } = inputSchema.parse(input);
  const now = options.now ?? Date.now;
  const errors: string[] = [];
  for (const host of BINANCE_MARKET_HOSTS) {
    const pages: Page[] = [];
    const routes = new Set<OutboundRoute>();
    let endTime: number | undefined;
    let exhausted = false;
    try {
      for (
        let have = 0;
        have < limit;
        have = pages.reduce((n, p) => n + p.length, 0)
      ) {
        const size = Math.min(PAGE, limit - have);
        const url = new URL("/api/v3/klines", host);
        url.search = new URLSearchParams({
          symbol: cryptoPair(symbol),
          interval: binanceInterval[period],
          limit: String(size),
          ...(endTime !== undefined ? { endTime: String(endTime) } : {}),
        }).toString();
        const { response, route } = await outboundFetch(
          url.toString(),
          {},
          options,
        );
        routes.add(route);
        const page = parseBinanceKlines(await readJson(response), period);
        pages.push(page);
        if (page.length < size) {
          exhausted = true;
          break;
        }
        endTime = page[0]!.openTime - 1;
      }
      const rows = mergeKlinePages(pages).slice(-limit);
      if (!rows.length) throw new Error("币安没有该交易对的 K 线");
      const current = now();
      return {
        version: BINANCE_KLINES_VERSION,
        source: "binance-spot",
        sourceUrl: `${host}/api/v3/klines`,
        bars: rows.map((r) => r.bar),
        formingDates: rows
          .filter((r) => r.closeTime >= current)
          .map((r) => r.bar.date),
        historyExhausted: exhausted,
        sourceNote: [
          `${BINANCE_KLINES_VERSION}；币安现货公开 K 线（UTC 收线，7×24 交易）`,
          `${new URL(host).host} ${[...routes].map(routeLabel).join("/")}`,
          ...errors,
        ].join("；"),
        sourceErrors: errors,
      };
    } catch (error) {
      errors.push(
        `${new URL(host).host}：${error instanceof Error ? error.message : "读取失败"}`,
      );
    }
  }
  throw new Error(`币安行情不可用：${errors.join("；")}`);
}
