import { z } from "zod";
import type { Market } from "./instrument";

import { periods } from "trading-strategy-core/bars";
export { periods };
export const periodSchema = z.enum(periods);
export type Period = (typeof periods)[number];
export const marketPeriods: Record<Market, readonly Period[]> = {
  "cn-equity": ["day", "week", "60m", "30m", "15m", "5m"],
  crypto: periods,
  futures: ["day", "week", "60m", "30m", "15m", "5m"],
};
/** Capability, rather than a selected value, decides what the UI offers. */
export function availablePeriods(market: Market, bases: readonly Period[]) {
  return marketPeriods[market].filter((period) =>
    bases.includes(basePeriod(market, period)),
  );
}
export function basePeriod(
  market: Market,
  period: Period | "month",
): "day" | "5m" | "1h" {
  if (period === "day" || period === "week" || period === "month") return "day";
  if (market === "crypto" && ["4h", "1h", "60m"].includes(period)) return "1h";
  return "5m";
}
