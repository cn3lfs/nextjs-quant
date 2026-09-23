import type { Bar } from "../../domain";
import type { Level } from "../../../server/strategies/breakout/breakout";

export const researchBreakoutStopVersion = "research-breakout-stop-1";

export function researchBreakoutStopLocation(
  kind: "breakout-candle" | "platform-upper",
  bar: Bar,
  previous: Bar,
  levels: readonly Level[],
) {
  if (kind === "breakout-candle")
    return Number.isFinite(bar.low) && bar.low > 0 && bar.low <= bar.close
      ? {
          price: bar.low,
          source: "breakout-candle" as const,
          confirmedAt: bar.date,
        }
      : null;
  // Only previously confirmed platforms crossed by this signal are eligible.
  const level = levels
    .filter(
      (level) =>
        level.source === "platform-high" &&
        level.confirmedAt < bar.date &&
        Number.isFinite(level.price) &&
        level.price > 0 &&
        previous.close <= level.price &&
        bar.close > level.price,
    )
    .sort((a, b) => b.index - a.index || b.price - a.price)[0];
  return level
    ? {
        price: level.price,
        source: "platform-high" as const,
        confirmedAt: level.confirmedAt,
      }
    : null;
}
