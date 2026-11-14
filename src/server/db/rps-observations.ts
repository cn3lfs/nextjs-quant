import { readSnapshot } from "./snapshot";
import { resolve } from "node:path";
import { get, sqlite } from "./index";
import type { RpsObservation } from "../screening/rps-observation";
export function latestRpsObservation(
  root: string,
  now = Date.now(),
): RpsObservation | null {
  return readSnapshot(() => {
    const rows = sqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind='rps-observation' AND json_extract(payload,'$.createdAt')<=? ORDER BY updated_at DESC,id DESC",
      )
      .iterate(now) as Iterable<{ payload: string }>;
    for (const row of rows) {
      const value = JSON.parse(row.payload) as RpsObservation;
      if (resolve(value.root) === resolve(root)) return value;
    }
    return null;
  });
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
export function previousCloseRpsObservation(
  root: string,
  previousTradingDay: string,
  availableAt: number,
) {
  return readSnapshot(() => {
    const rows = sqlite()
      .prepare(
        `SELECT payload FROM records WHERE kind='rps-observation'
     AND json_extract(payload,'$.date')=? AND json_extract(payload,'$.phase')='close'
     AND json_extract(payload,'$.createdAt')<=?
     ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC`,
      )
      .iterate(previousTradingDay, availableAt) as Iterable<{
      payload: string;
    }>;
    for (const row of rows) {
      const value = JSON.parse(row.payload) as RpsObservation;
      if (
        resolve(value.root) === resolve(root) &&
        value.day.date === previousTradingDay
      )
        return value;
    }
    return undefined;
  });
}
