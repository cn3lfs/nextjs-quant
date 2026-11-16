import type { StrategyObjectInput } from "trading-strategies";

/** Intraday bars are END labelled, daily bars are OPEN labelled. */
export function portfolioObservationDay(
  market: "cn-equity" | "crypto",
  period: StrategyObjectInput["period"],
  date: string,
) {
  if (date.length === 10) return date;
  const at =
    Date.parse(date) +
    (market === "cn-equity" ? 8 * 3600000 : /^\d+[mh]$/.test(period) ? -1 : 0);
  if (!Number.isFinite(at))
    throw new Error("Invalid completed portfolio bar date");
  return new Date(at).toISOString().slice(0, 10);
}
