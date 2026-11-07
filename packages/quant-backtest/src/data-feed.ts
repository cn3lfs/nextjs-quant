import { z } from "zod";
import { dateSchema, type Bar, type BacktestRequest } from "./model.js";
const barSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+08:00$/),
  open: z.number().finite().positive(),
  high: z.number().finite().positive(),
  low: z.number().finite().positive(),
  close: z.number().finite().positive(),
  volume: z.number().finite().nonnegative(),
  amount: z.number().finite().nonnegative(),
});
/** Read-only, ascending five-minute feed; missing observations are never filled. */
export function validateFiveMinuteFeed(
  input: BacktestRequest,
  bars: readonly Bar[],
  warmupBars: number,
) {
  for (let i = 0; i < bars.length; i++) {
    const b = barSchema.parse(bars[i]);
    const minutes =
      Number(b.date.slice(11, 13)) * 60 + Number(b.date.slice(14, 16));
    if (
      !dateSchema.safeParse(b.date.slice(0, 10)).success ||
      minutes % 5 !== 0 ||
      !(
        (minutes >= 575 && minutes <= 690) ||
        (minutes >= 785 && minutes <= 900)
      ) ||
      b.high < Math.max(b.open, b.close) ||
      b.low > Math.min(b.open, b.close) ||
      (i > 0 && b.date <= bars[i - 1]!.date)
    )
      throw new Error(`五分钟行情日期、顺序或 OHLC 非法：${b.date}`);
  }
  const startIndex = bars.findIndex((b) => b.date.slice(0, 10) >= input.start);
  if (
    startIndex < warmupBars ||
    !bars.some(
      (b) =>
        b.date.slice(0, 10) <= input.end && b.date.slice(0, 10) >= input.start,
    )
  )
    throw new Error(`研究窗口为空或缺少 ${warmupBars} 根预热行情`);
  return startIndex;
}
export function baselineBarOpenTime(barEnd: string) {
  const time = new Date(Date.parse(barEnd) - 5 * 60000 + 8 * 3600000);
  return `${time.toISOString().slice(0, 19)}+08:00`;
}
