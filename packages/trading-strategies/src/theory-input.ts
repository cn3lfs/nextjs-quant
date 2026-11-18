/**
 * Shared input primitives for theory/research rule consumers.
 *
 * A daily date here is a label, not candle completion: these helpers prove
 * the label is a real calendar day and that a run of labels ascends. Volume,
 * amount, closure and as-of availability remain the caller's responsibility.
 */

const DAY_LABEL = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Strict `YYYY-MM-DD` day label to UTC midnight epoch milliseconds.
 *
 * Mirrors trading-strategy-core's calendar strictness: pattern match, a
 * parseable value and an ISO roundtrip. Timestamps are rejected, and dates
 * never roll over (`2023-02-29` is null, not `2023-03-01`).
 */
export function dailyBarEpoch(date: unknown): number | null {
  if (typeof date !== "string" || !DAY_LABEL.test(date)) return null;
  const epoch = Date.parse(date);
  if (!Number.isFinite(epoch)) return null;
  if (new Date(epoch).toISOString().slice(0, 10) !== date) return null;
  return epoch;
}

/**
 * Four finite positive prices with `low <= open/close <= high`.
 *
 * Deliberately says nothing about date, volume or amount: callers add those
 * checks and must not treat this as proof that a full bar is valid.
 */
export function isValidOhlc(
  value: unknown,
): value is { open: number; high: number; low: number; close: number } {
  if (typeof value !== "object" || value === null) return false;
  const { open, high, low, close } = value as Record<string, unknown>;
  if (
    typeof open !== "number" ||
    typeof high !== "number" ||
    typeof low !== "number" ||
    typeof close !== "number"
  )
    return false;
  return (
    Number.isFinite(open) &&
    Number.isFinite(high) &&
    Number.isFinite(low) &&
    Number.isFinite(close) &&
    open > 0 &&
    high > 0 &&
    low > 0 &&
    close > 0 &&
    low <= open &&
    open <= high &&
    low <= close &&
    close <= high
  );
}

/**
 * Nonempty, strictly ascending, unique and valid daily labels.
 *
 * This is label ordering only; it is not intraday ordering or proof that a
 * candle closed.
 */
export function areDailyDatesStrictlyAscending(
  dates: readonly string[],
): boolean {
  if (!Array.isArray(dates) || dates.length === 0) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const date of dates) {
    const epoch = dailyBarEpoch(date);
    if (epoch === null || epoch <= previous) return false;
    previous = epoch;
  }
  return true;
}
