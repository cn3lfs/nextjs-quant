import { z } from "zod";
import type { Bar, Period } from "~/lib/domain";
export const eastmoneySymbolSchema = z
  .string()
  .regex(/^(?:(?:sh|sz|bj)\d{6}|emBK\d{4})$/);
export function eastmoneyIdentity(symbol: string) {
  eastmoneySymbolSchema.parse(symbol);
  return {
    code: symbol.slice(2),
    market: symbol.startsWith("em") ? 90 : symbol.startsWith("sh") ? 1 : 0,
  };
}

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
  const identity = eastmoneyIdentity(symbol);
  const checked = responseSchema.safeParse(raw);
  if (!checked.success)
    throw new Error("在线源未返回有效行情，请核对品种代码或稍后重试");
  const { data } = checked.data;
  if (data.code !== identity.code || data.market !== identity.market)
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
