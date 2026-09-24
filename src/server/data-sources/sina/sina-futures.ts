import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { futuresContract, futuresContracts } from "~/lib/market/futures";
import { outboundFetch, type OutboundOptions } from "../../infra/outbound";

export const SINA_FUTURES_VERSION = "sina-futures-1";
const BASE =
  "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_=/";
const services = {
  global: "GlobalFuturesService.getGlobalFuturesDailyKLine",
  inner: "InnerFuturesNewService.getDailyKLine",
} as const;

const num = z.union([z.string(), z.number()]).transform(Number);
const globalRow = z.object({
  date: z.string(),
  open: num,
  high: num,
  low: num,
  close: num,
  volume: num,
});
const innerRow = z
  .object({ d: z.string(), o: num, h: num, l: num, c: num, v: num })
  .transform((r) => ({
    date: r.d,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
    volume: r.v,
  }));

/**
 * Parse Sina's JSONP daily klines (the only period Sina serves here). Prices
 * are multiplied by `scale` (COMEX copper comes in cents per pound). Sina's
 * history has occasional broken rows; they are dropped and listed in
 * `excluded`, never repaired.
 */
export function parseSinaFuturesDaily(
  text: string,
  service: "global" | "inner",
  scale = 1,
) {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end <= start) throw new Error("新浪未返回有效期货行情");
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start + 1, end));
  } catch {
    throw new Error("新浪未返回有效期货行情");
  }
  const rows = z
    .array(service === "global" ? globalRow : innerRow)
    .min(1)
    .safeParse(raw);
  if (!rows.success) throw new Error("新浪未返回有效期货行情");
  const bars: Bar[] = [];
  const excluded: { date: string; reason: string }[] = [];
  for (const r of rows.data) {
    const [open, high, low, close] = [r.open, r.high, r.low, r.close].map(
      (v) => v * scale,
    ) as [number, number, number, number];
    const reason =
      !/^\d{4}-\d{2}-\d{2}$/.test(r.date) ||
      new Date(`${r.date}T00:00:00Z`).toISOString().slice(0, 10) !== r.date
        ? "日期无效"
        : bars.length && r.date <= bars.at(-1)!.date
          ? "日期重复或倒序"
          : ![open, high, low, close].every(
                (v) => Number.isFinite(v) && v > 0,
              ) ||
              !(Number.isFinite(r.volume) && r.volume >= 0) ||
              high < Math.max(open, close) ||
              low > Math.min(open, close)
            ? "新浪 OHLC 不自洽"
            : null;
    if (reason) excluded.push({ date: r.date, reason });
    else
      bars.push({
        date: r.date,
        open,
        high,
        low,
        close,
        volume: r.volume,
        amount: 0,
      });
  }
  if (!bars.length) throw new Error("新浪期货行情没有有效 K 线");
  return { bars, excluded };
}

export async function sinaFuturesDaily(
  symbol: string,
  limit: number,
  options: OutboundOptions = {},
) {
  const sina = futuresContract(symbol)?.sina;
  if (!sina) throw new Error("该品种没有新浪备用源");
  const url = `${BASE}${services[sina.service]}?symbol=${sina.code}`;
  const { response } = await outboundFetch(
    url,
    { headers: { Referer: "https://finance.sina.com.cn" } },
    options,
  );
  if (!response.ok) throw new Error(`新浪 HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 16 * 1024 * 1024) throw new Error("新浪响应超过读取上限");
  const parsed = parseSinaFuturesDaily(text, sina.service, sina.scale);
  const bars = parsed.bars.slice(-limit);
  const first = bars[0]!.date;
  return {
    version: SINA_FUTURES_VERSION,
    source: "sina-futures",
    sourceUrl: `${BASE}${services[sina.service]}`,
    bars,
    excluded: parsed.excluded.filter((e) => e.date >= first),
    historyExhausted: parsed.bars.length <= limit,
  };
}

const QUOTE_URL = "https://hq.sinajs.cn/list=";
const quoteCode = (service: "global" | "inner", code: string) =>
  `${service === "global" ? "hf" : "nf"}_${code}`;

/**
 * Sina realtime quotes. Global (`hf_`): price [0], previous settlement [7].
 * Domestic (`nf_`): price [8], previous settlement [10]. Change % is against
 * the previous settlement, matching Eastmoney's figure.
 */
export function parseSinaFuturesQuotes(text: string) {
  return futuresContracts.map((c) => {
    if (!c.sina) return { symbol: c.symbol, error: "无报价" };
    const key = quoteCode(c.sina.service, c.sina.code);
    const line = text.match(new RegExp(`hq_str_${key}="([^"]*)"`))?.[1];
    const fields = line?.split(",") ?? [];
    const scale = c.sina.scale ?? 1;
    const [price, prev] = (
      c.sina.service === "global"
        ? [fields[0], fields[7]]
        : [fields[8], fields[10]]
    ).map((v) => Number(v) * scale) as [number, number];
    if (!(Number.isFinite(price) && price > 0))
      return { symbol: c.symbol, error: "无报价" };
    return {
      symbol: c.symbol,
      close: price,
      changePct:
        Number.isFinite(prev) && prev > 0 ? (price / prev - 1) * 100 : null,
      time: null,
    };
  });
}

export async function sinaFuturesQuotes(options: OutboundOptions = {}) {
  const codes = futuresContracts
    .flatMap((c) => (c.sina ? [quoteCode(c.sina.service, c.sina.code)] : []))
    .join(",");
  const { response } = await outboundFetch(
    `${QUOTE_URL}${codes}`,
    { headers: { Referer: "https://finance.sina.com.cn" } },
    options,
  );
  if (!response.ok) throw new Error(`新浪 HTTP ${response.status}`);
  // Numbers and codes are ASCII; the GBK-encoded names are not used.
  return parseSinaFuturesQuotes(await response.text());
}
