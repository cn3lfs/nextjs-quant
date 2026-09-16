import type { Bar, Snapshot } from "~/lib/domain";
import { canslimCup } from "./canslim-cup";
import { canslimFlatBase } from "./canslim-flat-base";
import { canslimSaucer } from "./canslim-saucer";
import { canslimEntry } from "./canslim-entry";

/** Select geometry before testing entry; a waiting cup must not fall through. */
export function researchCanslimPriorityPoint(
  bars: readonly Bar[],
  qualification: "strict" | "scored-handles" = "strict",
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
  const cup = Number.isFinite(cutoff)
    ? canslimCup(
        snapshot,
        cutoff,
        qualification === "strict" ? "strict" : "v-score",
      )
    : null;
  const half =
    qualification === "scored-handles" && cup?.applicable
      ? canslimCup(snapshot, cutoff, "half-handle")
      : null;
  const flat = Number.isFinite(cutoff)
    ? canslimFlatBase({ ...snapshot, bars: bars.slice(-51) }, cutoff)
    : null;
  const saucer = Number.isFinite(cutoff)
    ? canslimSaucer({ ...snapshot, bars: bars.slice(-141) }, cutoff)
    : null;
  // An invalid full prefix cannot establish the absence of a preferred cup.
  const applicable = cup?.applicable === true;
  // The two qualified sets are disjoint: shrinking shallow handles score two
  // first, and the half-handle diagnostic accepts exactly one point.
  const cupCandidates =
    qualification === "strict"
      ? (cup?.candidates ?? [])
      : [
          ...(cup?.candidates ?? [])
            .filter((c) => c.qualified)
            .map((c) => ({
              ...c,
              handleQualification: "shrinking-third" as const,
            })),
          ...(half?.candidates ?? [])
            .filter((c) => c.qualified)
            .map((c) => ({
              ...c,
              handleQualification: "steady-half" as const,
            })),
        ];
  const selectedCup = applicable
    ? cupCandidates
        .filter((c) => c.qualified)
        .sort(
          (a, b) =>
            b.points - a.points ||
            b.duration - a.duration ||
            b.handleLength - a.handleLength ||
            b.pivot - a.pivot,
        )[0]
    : undefined;
  const selectedFlat =
    applicable && flat?.applicable
      ? flat.candidates
          .filter((c) => c.qualified)
          .sort(
            (a, b) =>
              b.points - a.points || b.length - a.length || b.high - a.high,
          )[0]
      : undefined;
  const selectedSaucer =
    applicable && saucer?.applicable
      ? saucer.candidates
          .filter((c) => c.qualified)
          .sort(
            (a, b) =>
              b.points - a.points || b.length - a.length || b.high - a.high,
          )[0]
      : undefined;
  const candidate = selectedCup
    ? { ...selectedCup, high: selectedCup.pivot, family: "cup" as const }
    : selectedFlat
      ? { ...selectedFlat, family: "flat" as const }
      : selectedSaucer
        ? { ...selectedSaucer, family: "saucer" as const }
        : null;
  const checks =
    applicable && candidate
      ? canslimEntry(snapshot, candidate.high, null, null, cutoff).checks
      : null;
  const entry = !!(
    checks?.closeAboveConfirmation &&
    checks.volumeConfirmed &&
    checks.withinFivePercent &&
    bars.at(-2)!.close <= candidate!.high * 1.01
  );
  return {
    date: last?.date ?? "",
    entry,
    exit: false,
    reason: applicable ? null : (cup?.reason ?? "缺少有效历史截止日"),
    values: { close: last && Number.isFinite(last.close) ? last.close : null },
    candidate,
    maxEntryPrice: candidate ? candidate.high * 1.05 : null,
    // Includes evidence for the absence of higher-priority geometry, not only
    // the selected base. Appending future bars does not change this start.
    historyStart: applicable ? bars[0]!.date : null,
  };
}
