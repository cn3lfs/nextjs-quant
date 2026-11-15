import type { ScoreboardRow } from "./validation-model";
export function selectShadowCandidates(rows: readonly ScoreboardRow[]) {
  const selected: ScoreboardRow[] = [];
  for (const key of new Set(
    rows
      .filter((r) => r.level === "strategy")
      .map((r) => `${r.market}|${r.sleeve}`),
  )) {
    selected.push(
      ...rows
        .filter(
          (r) =>
            r.level === "strategy" &&
            `${r.market}|${r.sleeve}` === key &&
            r.return !== null &&
            r.return > 0 &&
            r.worstDrawdown != null &&
            r.worstDrawdown <= 0.5 &&
            r.riskAdjusted?.sharpeDifference != null,
        )
        .sort(
          (a, b) =>
            a.reasons.length - b.reasons.length ||
            b.riskAdjusted!.sharpeDifference! -
              a.riskAdjusted!.sharpeDifference! ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 2),
    );
  }
  return selected;
}
