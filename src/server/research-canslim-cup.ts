import type { Bar, Snapshot } from "~/lib/domain";
import { canslimCup } from "./canslim-cup";
import { canslimEntry } from "./canslim-entry";

export function researchCanslimCupPoint(
  shape: "U" | "W" | "V",
  bars: readonly Bar[],
  qualification: "strict" | "half-handle" | "score-total" = "strict",
  rim: "symmetric" | "not-higher" = "symmetric",
) {
  const last = bars.at(-1);
  const cutoff = last ? Date.parse(`${last.date}T07:06:00Z`) : NaN;
  const snapshot: Snapshot = {
    id: "research-prefix",
    hash: "research-prefix",
    symbol: "research",
    period: "day",
    source: "research-dataset",
    adjustment: "none",
    historicalAsOf: last?.date,
    createdAt: Number.isFinite(cutoff) ? cutoff : 0,
    bars: [...bars],
  };
  const result = Number.isFinite(cutoff)
    ? canslimCup(
        snapshot,
        cutoff,
        qualification === "score-total"
          ? "score-total"
          : qualification === "half-handle"
            ? "half-handle"
            : shape === "V"
              ? "v-score"
              : "strict",
      )
    : null;
  const volume = result?.applicable
    ? canslimEntry(snapshot, null, null, null, cutoff).checks.volumeConfirmed
    : null;
  const selected =
    result?.applicable && volume
      ? (result.candidates
          .filter(
            (c) =>
              c.qualified &&
              (qualification === "score-total" || c.shape === shape) &&
              (rim === "symmetric" ||
                c.pivot <= bars.find((bar) => bar.date === c.left)!.high) &&
              c.breakoutAboveOnePercent &&
              last!.close <= c.pivot * 1.05 &&
              bars.at(-2)!.close <= c.pivot * 1.01,
          )
          .sort(
            (a, b) =>
              b.points - a.points ||
              b.duration - a.duration ||
              b.handleLength - a.handleLength ||
              b.pivot - a.pivot,
          )[0] ?? null)
      : null;
  const left = selected ? bars.findIndex((b) => b.date === selected.left) : -1;
  return {
    date: last?.date ?? "",
    entry: selected !== null,
    exit: false,
    reason: result?.applicable
      ? null
      : (result?.reason ?? "缺少有效历史截止日"),
    values: { close: last && Number.isFinite(last.close) ? last.close : null },
    shape: qualification === "score-total" ? "all-scored-shapes" : shape,
    ...(rim === "not-higher" ? { rimRule: "right-not-higher-than-left" } : {}),
    ...(qualification === "score-total"
      ? { qualification: "five-part-total-at-least-six" }
      : qualification === "half-handle"
        ? { qualification: "half-handle-score-1" }
        : shape === "V"
          ? { qualification: "v-score-with-strict-handle" }
          : {}),
    candidate: selected ? { ...selected, high: selected.pivot } : null,
    maxEntryPrice: selected ? selected.pivot * 1.05 : null,
    // The left rim needs three earlier peers; the 20-bar volume window is later.
    historyStart: left >= 3 ? bars[left - 3]!.date : null,
  };
}
