import type { CzscFamily } from "./czsc.js";
import type { StructureEvent } from "../technical/research-structure-events.js";

type EndObservation = Pick<StructureEvent<{ level: number }>, "kind" | "facts">;

/** Freshness is owned by the caller's prefix ledger; an absent end never delays a buy for backfill. */
export function chanZhongyinSignals(
  fresh: readonly CzscFamily["signals"][number][],
  observations: readonly EndObservation[],
  variant: 1 | 2,
) {
  const ended = observations.some(
    (row) =>
      row.facts.level === 0 &&
      row.kind ===
        (variant === 1 ? "zhongyin-structural-end" : "zhongyin-boll20-end"),
  );
  return fresh.filter(
    (point) => Math.abs(point.kind) === 3 && (point.kind < 0 || ended),
  );
}
