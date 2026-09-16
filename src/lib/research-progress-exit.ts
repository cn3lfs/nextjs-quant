import { z } from "zod";
import type { Bar } from "./domain";

export const researchProgressExitVersion = "research-progress-exit-1";
export const researchProgressExitSchema = z
  .object({
    clock: z.enum(["calendar-days", "trading-days"]),
    days: z.number().int().min(1).max(365),
    minimumGain: z.number().finite().min(0).max(1),
  })
  .strict();
export type ResearchProgressExit = z.infer<typeof researchProgressExitSchema>;
export const researchProgressExitDescription =
  "具名预设从实际首仓成交日起计算，自然28天或含入场日第20个研究交易日独立对照。到期首个有效收盘仅检查一次，涨幅严格不足5%则下一可成交开盘清仓；恰好5%通过，通过后不每日重测。休市、缺价、零量顺延到首个有效收盘，保留原到期日与实际检查日，不回填未知价格。应用预设重置其他组合风控并保留固定8%止损，信号与最长持有仍有效；持有期需足够长，提前退出没有四周结论。自定义组合以其天数、涨幅及止损配置为准。价格涨幅不含费用，不代表净收益或完整CANSLIM。";

/** Caller freezes the first returned check; missing closes never become a pass. */
export function researchProgressCheck(
  rule: ResearchProgressExit,
  entry: { entryDate: string; entryIndex: number; entryPrice: number },
  bar: Bar,
  index: number,
  calendar: readonly string[],
) {
  const elapsed =
    rule.clock === "calendar-days"
      ? (Date.parse(bar.date) - Date.parse(entry.entryDate)) / 86400000
      : index - entry.entryIndex + 1;
  if (!Number.isFinite(elapsed) || elapsed < rule.days) return null;
  if (
    bar.date !== calendar[index] ||
    ![
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      bar.volume,
      entry.entryPrice,
    ].every((value) => Number.isFinite(value) && value > 0) ||
    bar.high < Math.max(bar.open, bar.close, bar.low) ||
    bar.low > Math.min(bar.open, bar.close)
  )
    return null;
  const scheduledDate =
    rule.clock === "calendar-days"
      ? new Date(Date.parse(entry.entryDate) + rule.days * 86400000)
          .toISOString()
          .slice(0, 10)
      : calendar[entry.entryIndex + rule.days - 1]!;
  const thresholdPrice = entry.entryPrice * (1 + rule.minimumGain);
  if (!Number.isFinite(thresholdPrice)) return null;
  return {
    version: researchProgressExitVersion,
    ...rule,
    entryDate: entry.entryDate,
    entryPrice: entry.entryPrice,
    scheduledDate,
    checkedDate: bar.date,
    elapsed,
    close: bar.close,
    thresholdPrice,
    // Decimal prices such as 107.1 must equal 102 * 1.05 despite binary rounding.
    triggered:
      thresholdPrice - bar.close >
      Math.max(thresholdPrice, bar.close) * Number.EPSILON * 4,
  };
}
