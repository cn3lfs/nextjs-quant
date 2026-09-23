import type { Bar } from "../../domain";
import type { ResearchManagement } from "../workflow/research-management";
import { ma } from "../../indicators";

export const researchMarketRegimeVersion = "research-market-regime-1";
export function researchMarketEnvironment(
  benchmark: { symbol: string; bars: readonly Bar[] } | undefined,
  calendar: readonly string[],
  config: NonNullable<ResearchManagement["marketRegime"]>,
) {
  const bars = benchmark?.bars ?? [];
  if (
    bars.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        (i > 0 && bar.date <= bars[i - 1]!.date),
    ) ||
    calendar.some(
      (date, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        (i > 0 && date <= calendar[i - 1]!),
    )
  )
    throw new Error("大盘环境基准或交易日历未严格递增");
  const averages = ma(bars, 20),
    indices = new Map(bars.map((bar, i) => [bar.date, i]));
  return calendar.map((date, i) => {
    const observedDate = calendar[i - 1] ?? null;
    const j = observedDate ? indices.get(observedDate) : undefined;
    const window =
      j === undefined ? [] : bars.slice(Math.max(0, j - 20), j + 1);
    const valid =
      i >= 21 &&
      window.length === 21 &&
      window.every(
        (bar, n) =>
          bar.date === calendar[i - 21 + n] &&
          [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
            (v) => Number.isFinite(v) && v > 0,
          ) &&
          bar.high >= Math.max(bar.open, bar.close) &&
          bar.low <= Math.min(bar.open, bar.close),
      );
    const close = valid ? window[20]!.close : null;
    const current = valid ? (averages[j!] ?? null) : null;
    const previous = valid ? (averages[j! - 1] ?? null) : null;
    const ready =
      close != null &&
      current != null &&
      previous != null &&
      Number.isFinite(current) &&
      current > 0 &&
      Number.isFinite(previous) &&
      previous > 0;
    const regime = !ready
      ? "unknown"
      : close > current * (1 + config.neutralBand) && current > previous
        ? "strong"
        : close < current * (1 - config.neutralBand) && current < previous
          ? "weak"
          : "neutral";
    return {
      date,
      observedDate,
      benchmark: benchmark?.symbol ?? null,
      regime,
      close,
      ma20: current,
      previousMa20: previous,
      maxWeight:
        regime === "unknown"
          ? null
          : regime === "strong"
            ? 0.6
            : regime === "weak"
              ? config.weakWeight
              : 0.3,
      reason: ready ? null : "大盘环境缺少前21根连续有效基准日线，暂停买入",
    };
  });
}
