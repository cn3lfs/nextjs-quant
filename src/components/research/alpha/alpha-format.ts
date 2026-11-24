import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

export const pct = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${displayNumber(value * 100, digits)}%`;

export const num = (value: number | null | undefined, digits = 3) =>
  value == null || !Number.isFinite(value) ? "—" : displayNumber(value, digits);

export const integer = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : displayNumber(Math.round(value), 0);

export const signedPct = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : `${value > 0 ? "+" : ""}${displayNumber(value * 100, digits)}%`;

/** UTC wall clock: deterministic between the server render and hydration. */
export const stamp = (timestamp: number) =>
  `${new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export function mean(values: readonly number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

/**
 * Non-overlapping T+h cohorts anchored at the first observation. Daily forward
 * returns overlap for h > 1, so compounding every day would overstate the path.
 */
export function nonOverlappingCumulative(
  series: readonly { value: number | null }[],
  horizon: number,
) {
  let wealth = 1;
  let observed = 0;
  series.forEach((point, index) => {
    if (index % horizon !== 0 || point.value === null) return;
    if (!Number.isFinite(point.value)) return;
    wealth *= 1 + point.value;
    observed++;
  });
  return observed ? wealth - 1 : null;
}

export function returnTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value === 0)
    return "text-nc-text-3";
  return value > 0 ? "text-nc-up" : "text-nc-down";
}
