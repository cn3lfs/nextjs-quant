import { type RpsRow } from "quant-rps";
import type { RpsDay } from "~/lib/screening/rps";

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
export function observationRanking(
  observation: Pick<RpsObservation, "rows" | "day">,
  period: number,
) {
  const index = observation.day.periods.indexOf(period);
  return observation.rows.flatMap((row) =>
    row.values[index] ? [{ symbol: row.symbol, ...row.values[index]! }] : [],
  );
}
