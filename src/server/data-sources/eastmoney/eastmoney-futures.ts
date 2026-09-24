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

export const EASTMONEY_FUTURES_VERSION = "eastmoney-futures-1";
const ENDPOINT = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
const klt: Record<ChartPeriod, string> = {
  day: "101",
  week: "102",
  month: "103",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "60m": "60",
};

const inputSchema = z
  .object({
    symbol: futuresSymbolSchema,
    period: chartPeriodSchema,
    limit: z.number().int().min(1).max(20000).default(2000),
  })
  .strict();

const responseSchema = z.object({
  rc: z.literal(0),
  data: z.object({
    code: z.string(),
    market: z.number(),
    name: z.string().min(1),
    klines: z.array(z.string()).min(1).max(20000),
  }),
});

/**
 * Parse an Eastmoney futures kline response. Continuous contracts are taken
 * as served (no roll adjustment); malformed rows are rejected, never repaired.
 * Foreign contracts report amount 0, which is kept as-is.
 */
export function parseFuturesKlines(
  raw: unknown,
  symbol: string,
  period: ChartPeriod,
): { name: string; bars: Bar[] } {
  const contract = futuresContract(symbol);
  if (!contract) throw new Error("不支持的期货品种");
  const checked = responseSchema.safeParse(raw);
  if (!checked.success) throw new Error("东方财富未返回有效期货行情");
  const { data } = checked.data;
  if (`${data.market}.${data.code}` !== contract.secid)
    throw new Error("东方财富期货代码或市场不匹配");
  const minute = isMinutePeriod(period);
  const bars: Bar[] = [];
  for (const line of data.klines) {
    const fields = line.split(",");
    if (fields.length < 6 || fields.slice(0, 6).some((v) => !v.trim()))
      throw new Error("期货行情字段缺失");
    const date = minute
      ? `${fields[0]!.replace(" ", "T")}:00+08:00`
      : fields[0]!;
    if (
      !(
        minute
          ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/
          : /^\d{4}-\d{2}-\d{2}$/
      ).test(date) ||
      new Date(`${date.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !==
        date.slice(0, 10)
    )
      throw new Error("期货行情日期无效");
    const [open, close, high, low, volume] = fields.slice(1, 6).map(Number) as [
      number,
      number,
      number,
      number,
      number,
    ];
    const amount = fields[6] === undefined ? 0 : Number(fields[6]);
    if (
      ![open, close, high, low].every((v) => Number.isFinite(v) && v > 0) ||
      ![volume, amount].every((v) => Number.isFinite(v) && v >= 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      (bars.length && date <= bars.at(-1)!.date)
    )
      throw new Error("期货行情价格或日期顺序无效");
    bars.push({ date, open, close, high, low, volume, amount });
  }
  return { name: data.name, bars };
}

export async function eastmoneyFuturesKlines(
  input: z.input<typeof inputSchema>,
  options: OutboundOptions = {},
) {
  const { symbol, period, limit } = inputSchema.parse(input);
  const secid = futuresContract(symbol)!.secid;
  if (!secid) throw new Error("东方财富没有该品种");
  const contract = { ...futuresContract(symbol)!, secid };
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    secid: contract.secid,
    fields1: "f1,f2,f3",
    fields2: "f51,f52,f53,f54,f55,f56,f57",
    klt: klt[period],
    fqt: "0",
    end: "20500101",
    lmt: String(limit),
  }).toString();
  // Some networks drop direct Node connections to Eastmoney; fall back to the
  // configured outbound proxy like the crypto source does.
  const { response, route } = await outboundFetch(url.toString(), {}, options);
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024)
    throw new Error("东方财富响应超过读取上限");
  const { name, bars } = parseFuturesKlines(JSON.parse(text), symbol, period);
  return {
    version: EASTMONEY_FUTURES_VERSION,
    source: "eastmoney-futures",
    sourceUrl: ENDPOINT,
    name,
    bars,
    historyExhausted: bars.length < limit,
    sourceNote: `${EASTMONEY_FUTURES_VERSION}；东方财富${contract.exchange}连续/主连合约，不复权、未做换月调整，时间为北京时间；${routeLabel(route)}`,
  };
}

const QUOTE_ENDPOINT = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const quoteSchema = z.object({
  rc: z.literal(0),
  data: z.object({
    diff: z.array(
      z.object({
        f2: z.union([z.number(), z.string()]),
        f3: z.union([z.number(), z.string()]),
        f12: z.string(),
        f13: z.number(),
        f124: z.number().optional(),
      }),
    ),
  }),
});
export type FuturesQuote =
  | {
      symbol: string;
      close: number;
      /** Exchange change %, against the previous settlement price. */
      changePct: number | null;
      time: number | null;
      error?: undefined;
    }
  | { symbol: string; error: string; close?: undefined; changePct?: undefined };

/** Parse the batched realtime quotes; a missing or non-numeric row fails only that contract. */
export function parseFuturesQuotes(raw: unknown): FuturesQuote[] {
  const checked = quoteSchema.safeParse(raw);
  if (!checked.success) throw new Error("东方财富未返回有效期货报价");
  const rows = new Map(
    checked.data.data.diff.map((r) => [`${r.f13}.${r.f12}`, r]),
  );
  return futuresContracts.map((c) => {
    const row = c.secid ? rows.get(c.secid) : undefined;
    if (!row || typeof row.f2 !== "number" || !(row.f2 > 0))
      return { symbol: c.symbol, error: "无报价" };
    return {
      symbol: c.symbol,
      close: row.f2,
      changePct: typeof row.f3 === "number" ? row.f3 : null,
      time: row.f124 ? row.f124 * 1000 : null,
    };
  });
}

export async function eastmoneyFuturesQuotes(options: OutboundOptions = {}) {
  const url = new URL(QUOTE_ENDPOINT);
  url.search = new URLSearchParams({
    fltt: "2",
    fields: "f2,f3,f12,f13,f124",
    secids: futuresContracts
      .flatMap((c) => (c.secid ? [c.secid] : []))
      .join(","),
  }).toString();
  const { response } = await outboundFetch(url.toString(), {}, options);
  if (!response.ok) throw new Error(`东方财富 HTTP ${response.status}`);
  return parseFuturesQuotes(JSON.parse(await response.text()));
}
