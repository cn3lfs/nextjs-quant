import { resolve } from "node:path";
import type { RpsDay, RpsRow } from "~/lib/rps";
import { get, sqlite } from "./db";

export type RpsObservation = {
  id: string;
  phase: "noon" | "late" | "close";
  date: string;
  createdAt: number;
  baseline: string;
  root: string;
  fresh: number;
  total: number;
  coverage: number;
  quoteSources?: Record<string, number>;
  reused: string[];
  missing: string[];
  day: RpsDay;
  rows: RpsRow[];
  groups: Partial<
    Record<"industry" | "concept", { day: RpsDay; rows: RpsRow[] }>
  >;
};
export function latestRpsObservation(
  root: string,
  now = Date.now(),
): RpsObservation | null {
  const rows = sqlite()
    .prepare(
      "SELECT payload FROM records WHERE kind='rps-observation' AND json_extract(payload,'$.createdAt')<=? ORDER BY updated_at DESC LIMIT 20",
    )
    .all(now) as { payload: string }[];
  return (
    rows
      .map((row) => JSON.parse(row.payload) as RpsObservation)
      .find((row) => resolve(row.root) === resolve(root)) ?? null
  );
}
export function completedRpsObservation(
  root: string,
  date: string,
  phase: RpsObservation["phase"],
) {
  const id = get<{ id: string }>(`rps-observation-index-${date}-${phase}`)?.id;
  const value = id ? get<RpsObservation>(id) : undefined;
  return value && resolve(value.root) === resolve(root) ? value : null;
}
export function observationRanking(
  observation: Pick<RpsObservation, "rows" | "day">,
  period: number,
) {
  const index = observation.day.periods.indexOf(period);
  return observation.rows.flatMap((row) =>
    row.values[index] ? [{ symbol: row.symbol, ...row.values[index]! }] : [],
  );
}
