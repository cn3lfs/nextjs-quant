import { z } from "zod";
import type { Bar } from "~/lib/domain";
import { type ChartPeriod, isMinutePeriod } from "~/lib/chart-view";

const number = z.number().finite();
const tencentRow = z.object({
  symbol: z.string().optional(),
  date: z.string(),
  open: number.positive(),
  last: number.positive(),
  high: number.positive(),
  low: number.positive(),
  volume: number.nonnegative(),
  amount: number.nonnegative(),
});
export function parseWestockBars(
  raw: unknown,
  symbol: string,
  period: ChartPeriod,
): Bar[] {
  // The CLI may exit successfully with a structured service error; never accept that as data.
  const failure = z
    .object({
      success: z.literal(false),
      error: z.object({ code: z.string() }),
    })
    .safeParse(raw);
  if (failure.success)
    throw new Error(`腾讯 K 线服务不可用（${failure.data.error.code}）`);
  const rows = z.array(tencentRow).min(1).max(2000).parse(raw);
  const bars = rows.map((row) => {
    if (row.symbol && row.symbol !== symbol)
      throw new Error("腾讯行情证券不匹配");
    const date = isMinutePeriod(period)
      ? row.date.includes("+08:00")
        ? row.date
        : `${row.date.replace(" ", "T")}${row.date.length === 16 ? ":00" : ""}+08:00`
      : row.date;
    const day = date.slice(0, 10);
    if (
      !Number.isFinite(Date.parse(date)) ||
      new Date(day).toISOString().slice(0, 10) !== day ||
      !(
        isMinutePeriod(period)
          ? /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:00\+08:00$/
          : /^\d{4}-\d{2}-\d{2}$/
      ).test(date) ||
      row.high < Math.max(row.open, row.last, row.low) ||
      row.low > Math.min(row.open, row.last)
    )
      throw new Error("腾讯行情日期或价格非法");
    return {
      date,
      open: row.open,
      close: row.last,
      high: row.high,
      low: row.low,
      volume: row.volume,
      amount: row.amount,
    };
  });
  if (new Set(bars.map((bar) => bar.date)).size !== bars.length)
    throw new Error("腾讯行情日期重复");
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}
