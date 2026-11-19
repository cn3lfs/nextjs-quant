import { type Period } from "trading-strategy-core/bars";
import { type Market } from "./types.js";

export const dayOf = (date: string, market: Market) =>
  date.length === 10
    ? date
    : new Date(Date.parse(date) + (market === "cn-equity" ? 8 * 3600000 : 0))
        .toISOString()
        .slice(0, 10);
export const accountDate = (date: string, market: Market) => {
  if (date.length === 10) return date;
  const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(date);
  const time = Date.parse(
    zoned
      ? date
      : `${date.replace(" ", "T")}${market === "cn-equity" ? "+08:00" : "Z"}`,
  );
  return market === "cn-equity"
    ? new Date(time + 8 * 3600000).toISOString().replace("Z", "+08:00")
    : new Date(time).toISOString();
};
const periodMinutes: Partial<Record<Period, number>> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "1h": 60,
  "4h": 240,
};
export function nextBar(date: string, period: Period) {
  if (date.length === 10)
    return new Date(Date.parse(date) + (period === "week" ? 7 : 1) * 86400000)
      .toISOString()
      .slice(0, 10);
  return new Date(
    Date.parse(date) + (periodMinutes[period] ?? 1440) * 60000,
  ).toISOString();
}
