import type { LowZoneObservation } from "./historical-low.js";

export type LowZoneCycle = {
  start: string;
  end: string;
  complete: boolean;
  stages: { date: string; depth: number; share: number }[];
};
/** A cycle starts on the first observable low and ends on the first recovery.
 * Deepening adds stages; brief zone exits do not invent new market cycles. */
export function lowZoneCycles(
  rows: readonly LowZoneObservation[],
): LowZoneCycle[] {
  const cycles: LowZoneCycle[] = [];
  let active: LowZoneCycle | null = null;
  for (const row of rows) {
    if (!active && row.depth && row.depth > 0) {
      active = {
        start: row.date,
        end: row.date,
        complete: false,
        stages: [{ date: row.date, depth: row.depth, share: row.targetShare }],
      };
      cycles.push(active);
    } else if (
      active &&
      row.depth &&
      row.depth > Math.max(...active.stages.map((s) => s.depth))
    ) {
      active.stages.push({
        date: row.date,
        depth: row.depth,
        share: row.targetShare,
      });
    }
    if (active) {
      active.end = row.date;
      if (row.recovery) {
        active.complete = true;
        active = null;
      }
    }
  }
  return cycles;
}
