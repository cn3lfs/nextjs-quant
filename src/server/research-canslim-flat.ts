import type { Bar, Snapshot } from "~/lib/domain";
import { canslimFlatBase } from "./canslim-flat-base";

export const researchCanslimFlatVersion = "research-canslim-flat-1";

/** A bounded historical adapter; it does not request data or use wall-clock time. */
export function researchCanslimFlatPoint(bars: readonly Bar[]) {
  const last = bars.at(-1);
  const prefix = bars.slice(-51);
  const cutoff = last ? Date.parse(`${last.date}T07:06:00Z`) : NaN;
  const snapshot: Snapshot = {
    id: "research-prefix",
    symbol: "research",
    period: "day",
    source: "research-dataset",
    adjustment: "none",
    createdAt: Number.isFinite(cutoff) ? cutoff : 0,
    hash: "research-prefix",
    historicalAsOf: last?.date,
    bars: prefix,
  };
  const result = Number.isFinite(cutoff)
    ? canslimFlatBase(snapshot, cutoff)
    : null;
  if (!result?.applicable)
    return {
      date: last?.date ?? "",
      entry: false,
      values: {
        close: last && Number.isFinite(last.close) ? last.close : null,
      },
      exit: false,
      reason: result?.reason ?? "缺少有效历史截止日",
      candidate: null,
      maxEntryPrice: null,
    };
  const previous = prefix.at(-2)!;
  const candidates = result.candidates
    .filter(
      (candidate) =>
        candidate.qualified &&
        candidate.breakout.closeAboveConfirmation &&
        candidate.breakout.withinFivePercent &&
        candidate.breakout.volumeConfirmed &&
        previous.close <= candidate.high * 1.01,
    )
    .sort(
      (a, b) => b.points - a.points || b.length - a.length || b.high - a.high,
    );
  const candidate = candidates[0] ?? null;
  return {
    date: last!.date,
    entry: candidate !== null,
    values: { close: last!.close },
    exit: false,
    reason: null,
    candidate,
    maxEntryPrice: candidate ? candidate.high * 1.05 : null,
  };
}
