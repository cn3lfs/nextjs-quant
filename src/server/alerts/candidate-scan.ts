import type { StrategyObjectInput } from "trading-strategies";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";
import { beijingClock } from "~/lib/market/market-session";

/** Persist even an empty scan so yesterday's candidates cannot masquerade as current. */
export function candidateScanWatermark(
  strategy: StrategyObjectInput,
  now: number,
  closeDate?: string,
  completedBar?: string | null,
) {
  let bar: string | null = completedBar ?? null;
  if (strategy.market === "crypto") {
    if (strategy.period === "week") {
      const day = new Date(now),
        dayMs = 86400000;
      const monday =
        Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) -
        ((day.getUTCDay() + 6) % 7) * dayMs;
      bar = new Date(monday - 7 * dayMs).toISOString().slice(0, 10);
    } else {
      const step = cryptoPeriodMs[strategy.period]!;
      const boundary = Math.floor(now / step) * step;
      bar =
        strategy.period === "day"
          ? new Date(boundary - step).toISOString().slice(0, 10)
          : new Date(boundary).toISOString().replace(".000Z", "+00:00");
    }
  } else if (strategy.period === "day")
    bar = closeDate ?? beijingClock(now).date;
  return {
    id: `candidate-scan:${strategy.market}:${strategy.id}:${strategy.version}`,
    value: {
      market: strategy.market,
      strategyId: strategy.id,
      version: strategy.version,
      period: strategy.period,
      bar,
      observedAt: now,
    },
  };
}
