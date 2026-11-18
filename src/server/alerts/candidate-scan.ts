import type { StrategyObjectInput } from "trading-strategies";
import type { Period } from "~/lib/domain";
import { cryptoPeriodMs } from "~/lib/market/crypto-aggregation";
import { beijingClock } from "~/lib/market/market-session";
import { closeScanWindow } from "~/lib/market/close-scan-window";

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

export type CandidateScanState = {
  bar: string | null;
  observedAt: number;
  period?: Period;
};
export type CandidateScanFreshness =
  "current" | "stale" | "intraday" | "unknown";

/** A watermark only proves the scan phase ran; it never proves the full market
 * was covered. Compare it with the latest completed local close instead of the
 * wall-clock date so weekends and pre-close reads keep yesterday's window. */
export function candidateScanFreshness(
  scan: CandidateScanState | undefined,
  period: Period,
  reference: { closeDate: string | null; calendar: readonly string[] },
): CandidateScanFreshness {
  // Intraday scans are only observations; never present them as this close.
  if (period !== "day" && period !== "week") return "intraday";
  const { closeDate, calendar } = reference;
  if (!closeDate || !calendar.length || !calendar.includes(closeDate))
    return "unknown";
  if (period === "day") {
    if (!scan?.bar || !calendar.includes(scan.bar)) return "unknown";
    if (scan.bar > closeDate) return "unknown";
    return scan.bar === closeDate ? "current" : "stale";
  }
  // Weekly bars complete with the 15:05 close. The scan time, not the bar
  // label, distinguishes tonight's scan from a previous week's candidate.
  if (!scan) return "unknown";
  const window = closeScanWindow(closeDate, calendar);
  return scan.observedAt >= Date.parse(`${closeDate}T15:05:00+08:00`) &&
    scan.observedAt < window.deadline
    ? "current"
    : "stale";
}
