import type { Bar, Snapshot } from "~/lib/domain";
import { canslimEntry } from "./canslim-entry";
import type { researchCanslimPriorityPoint } from "./research-canslim-priority";

type Point = ReturnType<typeof researchCanslimPriorityPoint>;
export function researchCanslimVolumeWait(
  points: readonly Point[],
  bars: readonly Bar[],
  calendar: readonly string[],
  maxDays: 3 | 5,
) {
  const dates = new Map(calendar.map((date, index) => [date, index]));
  let pending: {
    point: Point;
    start: number;
    last: number;
    volume: number;
    volume20: number;
  } | null = null;
  return points.map((point, index) => {
    const bar = bars[index];
    const day = dates.get(point.date);
    const cutoff = Date.parse(`${point.date}T07:06:00Z`);
    const snapshot: Snapshot = {
      id: "research-prefix",
      hash: "research-prefix",
      symbol: "research",
      period: "day",
      source: "research-dataset",
      adjustment: "none",
      historicalAsOf: point.date,
      createdAt: Number.isFinite(cutoff) ? cutoff : 0,
      bars: bars.slice(Math.max(0, index - 20), index + 1),
    };
    const diagnostic = Number.isFinite(cutoff)
      ? canslimEntry(
          snapshot,
          pending?.point.candidate?.high ?? point.candidate?.high ?? null,
          null,
          null,
          cutoff,
        )
      : null;
    const valid =
      bar?.date === point.date &&
      !point.reason &&
      diagnostic?.volume20 != null &&
      day != null;
    const emit = (
      source: NonNullable<typeof pending>,
      status: "waiting" | "confirmed" | "cancelled" | "expired",
      reason: string | null,
    ) => ({
      ...point,
      entry: status === "confirmed",
      candidate: source.point.candidate,
      maxEntryPrice: source.point.maxEntryPrice,
      historyStart: source.point.historyStart,
      volumeWait: {
        status,
        reason,
        breakoutDate: source.point.date,
        confirmationDate: status === "confirmed" ? point.date : null,
        pivot: source.point.candidate!.high,
        maxDays,
        elapsed: day == null ? null : day - source.start,
        initialVolume: source.volume,
        initialVolume20: source.volume20,
        volume20: diagnostic?.volume20 ?? null,
      },
    });
    if (pending) {
      const source = pending;
      if (!valid || day !== source.last + 1) {
        pending = null;
        return emit(source, "cancelled", "等待期间缺日或行情无效");
      }
      if (day - source.start > maxDays) {
        pending = null;
        return emit(source, "expired", "等待期限结束");
      }
      const pivot = source.point.candidate!.high;
      if (bar.close < pivot || bar.close > pivot * 1.05) {
        pending = null;
        return emit(
          source,
          "cancelled",
          bar.close < pivot ? "收盘跌破原枢纽" : "收盘超过原枢纽105%",
        );
      }
      if (
        diagnostic.checks.closeAboveConfirmation &&
        diagnostic.checks.withinFivePercent &&
        diagnostic.checks.volumeConfirmed
      ) {
        pending = null;
        return emit(source, "confirmed", null);
      }
      if (day - source.start === maxDays) {
        pending = null;
        return emit(source, "expired", "等待期限结束仍未补量确认");
      }
      pending.last = day;
      return emit(source, "waiting", null);
    }
    if (
      valid &&
      point.candidate &&
      diagnostic.checks.closeAboveConfirmation &&
      diagnostic.checks.withinFivePercent &&
      bar.volume < diagnostic.volume20! &&
      bars[index - 1]!.close <= point.candidate.high * 1.01
    ) {
      pending = {
        point,
        start: day,
        last: day,
        volume: bar.volume,
        volume20: diagnostic.volume20!,
      };
      return emit(pending, "waiting", null);
    }
    return { ...point, entry: false };
  });
}
