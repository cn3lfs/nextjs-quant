import { createHash } from "node:crypto";
import { z } from "zod";
import type { Bar, Period, Snapshot } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";

const responseSchema = z.object({
  rc: z.literal(0),
  data: z.object({
    code: z.string(),
    market: z.number(),
    name: z.string().min(1),
    klines: z.array(z.string()).min(1).max(20000),
  }),
});
export function parseOnlineChart(
  raw: unknown,
  symbol: string,
  period: Period,
): { name: string; bars: Bar[] } {
  symbolSchema.parse(symbol);
  const checked = responseSchema.safeParse(raw);
  if (!checked.success)
    throw new Error("在线源未返回有效行情，请核对品种代码或稍后重试");
  const { data } = checked.data;
  if (
    data.code !== symbol.slice(2) ||
    data.market !== (symbol.startsWith("sh") ? 1 : 0)
  )
    throw new Error("在线行情证券代码或市场不匹配");
  const bars: Bar[] = [];
  for (const line of data.klines) {
    const fields = line.split(",");
    if (fields.length !== 7 || fields.some((v) => !v.trim()))
      throw new Error("在线行情字段缺失");
    const date =
      period === "day"
        ? fields[0]!
        : `${fields[0]!.replace(" ", "T")}:00+08:00`;
    if (
      !(
        period === "day"
          ? /^\d{4}-\d{2}-\d{2}$/
          : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/
      ).test(date) ||
      !Number.isFinite(Date.parse(date))
    )
      throw new Error("在线行情日期无效");
    if (
      new Date(date.slice(0, 10)).toISOString().slice(0, 10) !==
      date.slice(0, 10)
    )
      throw new Error("在线行情日期无效");
    const [open, close, high, low, volume, amount] = fields
      .slice(1)
      .map(Number) as [number, number, number, number, number, number];
    if (
      ![open, close, high, low].every((v) => Number.isFinite(v) && v > 0) ||
      ![volume, amount].every((v) => Number.isFinite(v) && v >= 0) ||
      high < Math.max(open, close) ||
      low > Math.min(open, close) ||
      high < low ||
      (bars.length && date <= bars.at(-1)!.date)
    )
      throw new Error("在线行情价格或日期顺序无效");
    bars.push({ date, open, close, high, low, volume, amount });
  }
  return { name: data.name, bars };
}

export async function onlineChartSnapshot(
  symbol: string,
  period: Period,
): Promise<Snapshot> {
  symbolSchema.parse(symbol);
  if (!/^(sh|sz)/.test(symbol)) throw new Error("在线图表暂支持沪深市场");
  const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
  url.search = new URLSearchParams({
    secid: `${symbol.startsWith("sh") ? 1 : 0}.${symbol.slice(2)}`,
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57",
    klt: period === "day" ? "101" : "5",
    fqt: "0",
    beg: "0",
    end: "20500101",
    lmt: "20000",
  }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`在线行情请求失败（${response.status}）`);
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new Error("在线行情超过读取上限");
  const { name, bars } = parseOnlineChart(JSON.parse(text), symbol, period);
  const hash = createHash("sha256")
    .update(symbol)
    .update(period)
    .update(text)
    .digest("hex");
  return {
    id: `snapshot-online-${symbol}-${period}-${hash.slice(0, 16)}`,
    symbol,
    name,
    period,
    source: "eastmoney-online",
    adjustment: "none",
    createdAt: Date.now(),
    bars,
    hash,
    sourceUrl: url.toString(),
    volumeUnit: "手",
  };
}
