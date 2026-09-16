import type { Bar } from "./domain";

export const sepaEliteDescription =
  "精英工程版：实际首仓日起21个自然日内有效收盘达到首仓价120%，冻结首仓日加56个自然日为尾仓时间到期日；原文未明确八周起算，本版从首仓日起算。以完整研究日历及有效OHLCV验证入场至确认日，缺日不触发、不补造。未达标采用20个交易日最长持有；达标后仅替换时间到期，既有止损、分批止盈、周线与大阴退出照常执行，已确认退出不撤销。并非保证持满八周或盈利。";
export function researchSepaElite(
  entry: { entryDate: string; entryPrice: number },
  date: string,
  calendar: readonly string[],
  bars: ReadonlyMap<string, Bar>,
) {
  const elapsed = (Date.parse(date) - Date.parse(entry.entryDate)) / 86400000;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 21) return null;
  const dates = calendar.filter((d) => d >= entry.entryDate && d <= date);
  if (
    dates[0] !== entry.entryDate ||
    dates.at(-1) !== date ||
    !dates.every((d) => {
      const b = bars.get(d);
      return (
        b &&
        [b.open, b.high, b.low, b.close, b.volume].every(
          (v) => Number.isFinite(v) && v > 0,
        ) &&
        b.high >= Math.max(b.open, b.close, b.low) &&
        b.low <= Math.min(b.open, b.close)
      );
    })
  )
    return null;
  const close = bars.get(date)!.close;
  if (
    !Number.isFinite(entry.entryPrice) ||
    entry.entryPrice <= 0 ||
    close < entry.entryPrice * 1.2
  )
    return null;
  return {
    version: "sepa-elite-entry56-1",
    confirmedDate: date,
    entryDate: entry.entryDate,
    close,
    threshold: entry.entryPrice * 1.2,
    elapsed,
    holdUntil: new Date(Date.parse(entry.entryDate) + 56 * 86400000)
      .toISOString()
      .slice(0, 10),
  };
}
