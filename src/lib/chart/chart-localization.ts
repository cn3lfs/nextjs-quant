import { TickMarkType, type Time } from "lightweight-charts";

function dateText(time: Time) {
  // chartTime already shifts intraday instants to Shanghai wall-clock seconds.
  // Read UTC fields here to avoid applying the user's browser timezone twice.
  if (typeof time === "number")
    return new Date(time * 1000).toISOString().slice(0, 16).replace("T", " ");
  if (typeof time === "string") return time;
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}
export const chineseChartLocalization = {
  locale: "zh-CN",
  dateFormat: "yyyy-MM-dd",
  timeFormatter: dateText,
};
export function chineseTickMark(time: Time, kind: TickMarkType) {
  const text = dateText(time);
  if (kind === TickMarkType.Year) return `${text.slice(0, 4)}年`;
  if (kind === TickMarkType.Month) return `${Number(text.slice(5, 7))}月`;
  if (kind === TickMarkType.DayOfMonth) return `${Number(text.slice(8, 10))}日`;
  return text.slice(11, 16);
}
