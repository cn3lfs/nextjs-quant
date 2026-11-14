import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { chinaDate } from "../market/security-trading-status";

/** The daily execution engine currently supports these stock lot conventions. */
export const isStudyStockSymbol = (symbol: string) =>
  /^(sh60|sz00|sz30)\d{4}$/.test(symbol);

export function latestHistoricalDate(days: readonly string[], now: number) {
  const today = chinaDate(now);
  return days.reduce<string | null>(
    (latest, day) =>
      researchDateSchema.safeParse(day).success &&
      day < today &&
      (!latest || day > latest)
        ? day
        : latest,
    null,
  );
}

export function defaultStudyStart(end: string) {
  return researchDateSchema.safeParse(end).success
    ? new Date(Date.parse(end) - 365 * 86400000).toISOString().slice(0, 10)
    : "";
}

export function studyDateError(
  start: string,
  end: string,
  now: number | null,
  maximumDays?: number,
) {
  if (
    !researchDateSchema.safeParse(start).success ||
    !researchDateSchema.safeParse(end).success
  )
    return "请选择有效的开始和结束日期";
  if (start > end) return "开始日期不能晚于结束日期";
  if (now === null) return "正在确定当前日期";
  if (end >= chinaDate(now)) return "仅支持今天之前的历史日期（上海时间）";
  if (
    maximumDays !== undefined &&
    (Date.parse(end) - Date.parse(start)) / 86400000 >= maximumDays
  )
    return `研究区间不能超过${maximumDays}个自然日`;
  return null;
}
