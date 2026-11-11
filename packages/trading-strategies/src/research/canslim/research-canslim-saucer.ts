import type { Bar } from "trading-strategy-core/bars";
import type { GrowthPriceInput } from "../contracts/growth-price-input.js";
import { canslimSaucer } from "./canslim-saucer.js";
import { canslimEntry } from "./canslim-entry.js";

export function researchCanslimSaucerPoint(
  shape: "U" | "W",
  bars: readonly Bar[],
) {
  const prefix = bars.slice(-141);
  const last = prefix.at(-1);
  const cutoff = last ? Date.parse(`${last.date}T07:06:00Z`) : NaN;
  const snapshot: GrowthPriceInput = {
    id: "research-prefix",
    hash: "research-prefix",
    symbol: "research",
    period: "day",

    adjustment: "none",

    historicalAsOf: last?.date,
    bars: prefix,
  };
  const result = Number.isFinite(cutoff)
    ? canslimSaucer(snapshot, cutoff)
    : null;
  const volume = result?.applicable
    ? canslimEntry(snapshot, null, null, null, cutoff).checks.volumeConfirmed
    : null;
  const candidate =
    result?.applicable && volume
      ? (result.candidates
          .filter(
            (c) =>
              c.qualified &&
              c.shape === shape &&
              c.breakoutAboveOnePercent &&
              last!.close <= c.high * 1.05 &&
              prefix.at(-2)!.close <= c.high * 1.01,
          )
          .sort(
            (a, b) =>
              b.points - a.points || b.length - a.length || b.high - a.high,
          )[0] ?? null)
      : null;
  return {
    date: last?.date ?? "",
    entry: candidate !== null,
    exit: false,
    reason: result?.applicable
      ? null
      : (result?.reason ?? "缺少有效历史截止日"),
    values: { close: last && Number.isFinite(last.close) ? last.close : null },
    shape,
    candidate,
    maxEntryPrice: candidate ? candidate.high * 1.05 : null,
  };
}
